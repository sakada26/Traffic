import cv2
import sqlite3
import time
from datetime import datetime
import json
import os
import threading
import queue
import numpy as np
from flask import Flask, Response, jsonify, request, session, redirect
from functools import wraps

app = Flask(__name__, static_folder='public', static_url_path='')
app.secret_key = "trafical-security-salt-2026"

PORT = 8000
DB_FILE = os.path.join("data", "db.json")
SQLITE_DB = os.path.join("data", "detections.db")

# Ensure directories exist
os.makedirs("data", exist_ok=True)
os.makedirs("public", exist_ok=True)

# Locks for thread safety
db_lock = threading.Lock()
sse_lock = threading.Lock()
frame_lock = threading.Lock()
timestamps_lock = threading.Lock()
history_lock = threading.Lock()

# SSE clients
sse_clients = []

# Application State (loaded from db.json)
state = {
    "total_cars": 0,
    "total_motos": 0,
    "config": {
        "alert_threshold": 5,  # vehicles on road
        "camera_url": "http://192.168.1.23/stream",
        "conf_threshold": 0.5,
        "show_overlay": True
    }
}

# In-memory sliding window for flow rate (timestamps of last 60 seconds)
detection_timestamps = []

# Minute-by-minute historical counts
# Key: unix timestamp rounded to minute
# Value: {"cars": X, "motos": Y}
history_stats = {}

# YOLO and camera state variables
latest_frame = None
current_vehicle_count = 0
current_status = "Light"  # "Light", "Moderate", "Heavy"
last_logged_status = None

# Individual vehicle logging cooldown
last_logged_time = {}
COOLDOWN_SECONDS = 5  

TARGET_CLASSES = {2: "Car", 3: "Motorcycle", 5: "Bus", 7: "Truck", 1: "Bicycle"}

def load_db():
    global state
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r") as f:
                data = json.load(f)
                state["total_cars"] = data.get("total_cars", 0)
                state["total_motos"] = data.get("total_motos", 0)
                state["users"] = data.get("users", {
                    "admin": "admin"
                })
                state["config"] = data.get("config", {
                    "alert_threshold": 5,
                    "camera_url": "http://192.168.1.23/stream",
                    "conf_threshold": 0.5,
                    "show_overlay": True
                })
                if "conf_threshold" not in state["config"]:
                    state["config"]["conf_threshold"] = 0.5
                if "show_overlay" not in state["config"]:
                    state["config"]["show_overlay"] = True
                if "alert_threshold" not in state["config"]:
                    state["config"]["alert_threshold"] = 5
                print(f"Loaded existing database: Cars={state['total_cars']}, Motos={state['total_motos']}")
        except Exception as e:
            print(f"Error loading database: {e}")
    else:
        state["users"] = {"admin": "admin"}

def save_db():
    with db_lock:
        try:
            with open(DB_FILE, "w") as f:
                json.dump({
                    "total_cars": state["total_cars"],
                    "total_motos": state["total_motos"],
                    "config": state["config"],
                    "users": state.get("users", {"admin": "admin"})
                }, f, indent=2)
        except Exception as e:
            print(f"Error saving database: {e}")

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated_function

def update_traffic_status(count):
    global current_vehicle_count, current_status, last_logged_status
    current_vehicle_count = count
    
    with db_lock:
        threshold = state["config"].get("alert_threshold", 5)
        
    if current_vehicle_count >= threshold:
        current_status = "Heavy"
    elif current_vehicle_count >= max(1, threshold // 2):
        current_status = "Moderate"
    else:
        current_status = "Light"
        
    # Log density changes to SQLite
    if current_status != last_logged_status:
        log_density_change(current_vehicle_count, current_status)
        last_logged_status = current_status
        
    flow_rate = get_current_flow_rate()
    warning_active = (current_status == "Heavy") or (flow_rate > threshold)
        
    # Broadcast status change to SSE clients
    broadcast_event("status_change", {
        "count": current_vehicle_count,
        "status": current_status,
        "warning_active": warning_active
    })

def init_db():
    conn = sqlite3.connect(SQLITE_DB)
    cursor = conn.cursor()
    
    # Table for individual vehicle logs
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS vehicle_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            vehicle_type TEXT,
            confidence REAL
        )
    ''')
    
    # Table to track overall traffic density history
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS traffic_density_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            vehicle_count INTEGER,
            status TEXT
        )
    ''')
    conn.commit()
    conn.close()

def log_detection_to_db(vehicle_type, confidence):
    try:
        conn = sqlite3.connect(SQLITE_DB)
        cursor = conn.cursor()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            "INSERT INTO vehicle_logs (timestamp, vehicle_type, confidence) VALUES (?, ?, ?)",
            (now, vehicle_type, round(float(confidence), 2))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error logging vehicle log to SQLite: {e}")

def log_density_change(vehicle_count, status):
    try:
        conn = sqlite3.connect(SQLITE_DB)
        cursor = conn.cursor()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            "INSERT INTO traffic_density_logs (timestamp, vehicle_count, status) VALUES (?, ?, ?)",
            (now, vehicle_count, status)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error logging density status to SQLite: {e}")

def broadcast_event(event_type, event_data):
    payload = json.dumps({"type": event_type, "data": event_data})
    with sse_lock:
        for q in sse_clients:
            q.put(payload)

def add_detection(vehicle_type, confidence=1.0, log_to_sqlite=True):
    global detection_timestamps
    vehicle_type = vehicle_type.lower().strip()
    if vehicle_type not in ["car", "moto", "motorcycle"]:
        return False
        
    if vehicle_type == "motorcycle":
        vehicle_type = "moto"

    now = time.time()
    
    # 1. Update stats
    with db_lock:
        if vehicle_type == "car":
            state["total_cars"] += 1
        elif vehicle_type == "moto":
            state["total_motos"] += 1
            
    # Save database in background
    threading.Thread(target=save_db).start()

    # 2. Update flow rate window
    with timestamps_lock:
        detection_timestamps.append(now)
        # Keep only last 60 seconds
        detection_timestamps = [t for t in detection_timestamps if now - t <= 60]
        current_flow_rate = len(detection_timestamps)

    # 3. Update history bin
    current_minute = int(now / 60) * 60
    with history_lock:
        if current_minute not in history_stats:
            history_stats[current_minute] = {"cars": 0, "motos": 0}
        
        if vehicle_type == "car":
            history_stats[current_minute]["cars"] += 1
        else:
            history_stats[current_minute]["motos"] += 1
            
        # Keep history to last 30 minutes
        cutoff = current_minute - (30 * 60)
        for k in list(history_stats.keys()):
            if k < cutoff:
                del history_stats[k]

    # Calculate alert status
    threshold = state["config"]["alert_threshold"]
    warning_active = (current_status == "Heavy") or (current_flow_rate > threshold)

    # 4. Broadcast event
    event_payload = {
        "timestamp": now,
        "type": vehicle_type,
        "total_cars": state["total_cars"],
        "total_motos": state["total_motos"],
        "flow_rate": current_flow_rate,
        "warning_active": warning_active
    }
    broadcast_event("detection", event_payload)
    print(f"Registered {vehicle_type} detection. Flow VPM: {current_flow_rate}/{threshold}")
    
    if log_to_sqlite:
        sqlite_label = "Car" if vehicle_type == "car" else "Motorcycle"
        log_detection_to_db(sqlite_label, confidence)
        
    return True

def get_current_flow_rate():
    now = time.time()
    with timestamps_lock:
        global detection_timestamps
        detection_timestamps = [t for t in detection_timestamps if now - t <= 60]
        return len(detection_timestamps)

def get_history_list():
    now = time.time()
    current_minute = int(now / 60) * 60
    history = []
    with history_lock:
        for i in range(15):  # Last 15 minutes
            minute = current_minute - (i * 60)
            stats = history_stats.get(minute, {"cars": 0, "motos": 0})
            history.append({
                "time": time.strftime("%H:%M", time.localtime(minute)),
                "timestamp": minute,
                "cars": stats["cars"],
                "motos": stats["motos"],
                "total": stats["cars"] + stats["motos"]
            })
    history.reverse()
    return history

# YOLO Thread
def yolo_thread_fn():
    from ultralytics import YOLO
    global current_vehicle_count, current_status, last_logged_status, latest_frame
    
    print("Initializing YOLOv8 model in background thread...")
    try:
        model = YOLO("yolov8n.pt")
        print("YOLOv8 model loaded successfully.")
    except Exception as e:
        print(f"Error loading YOLOv8 model: {e}")
        return
        
    while True:
        with db_lock:
            stream_url = state["config"]["camera_url"]
            
        print(f"Opening camera stream: {stream_url}")
        cap = cv2.VideoCapture(stream_url)
        
        if not cap.isOpened():
            print(f"Failed to connect to camera stream at {stream_url}. Retrying in 5 seconds...")
            # Generate placeholder frame when stream is offline
            placeholder = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(placeholder, "Camera Stream Offline", (150, 240),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2)
            cv2.putText(placeholder, stream_url, (100, 280),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
            ret, buffer = cv2.imencode('.jpg', placeholder)
            if ret:
                with frame_lock:
                    latest_frame = buffer.tobytes()
            update_traffic_status(0)
            time.sleep(5)
            continue

        print(f"Camera stream connected successfully.")
        
        while cap.isOpened():
            # Check if camera stream URL has changed in settings
            with db_lock:
                current_stream_url = state["config"]["camera_url"]
            if current_stream_url != stream_url:
                print("Camera URL updated. Reconnecting to new stream address...")
                break
                
            success, frame = cap.read()
            if not success:
                print("Lost stream frames. Reconnecting...")
                time.sleep(1)
                break
                
            with db_lock:
                conf_thresh = state["config"].get("conf_threshold", 0.5)
                show_overlay = state["config"].get("show_overlay", True)
                
            results = model(frame, verbose=False)
            current_time = time.time()
            frame_vehicle_count = 0
            
            for result in results:
                for box in result.boxes:
                    class_id = int(box.cls[0])
                    confidence = float(box.conf[0])
                    
                    if class_id in TARGET_CLASSES and confidence > conf_thresh:
                        frame_vehicle_count += 1
                        label = TARGET_CLASSES[class_id]
                        
                        # Draw bounding box & labels on the live frame if enabled
                        if show_overlay:
                            x1, y1, x2, y2 = map(int, box.xyxy[0])
                            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                            cv2.putText(frame, f"{label} {confidence:.2f}", (x1, y1 - 10),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                                    
                        # Cooldown detection logging
                        is_car = label in ["Car", "Bus", "Truck"]
                        v_type = "car" if is_car else "moto"
                        
                        if label not in last_logged_time or (current_time - last_logged_time[label] > COOLDOWN_SECONDS):
                            add_detection(v_type, confidence=confidence, log_to_sqlite=False)
                            log_detection_to_db(label, confidence)
                            last_logged_time[label] = current_time

            # Update live stats with unified status helper
            update_traffic_status(frame_vehicle_count)
                
            # Compress and store frame for the video stream endpoint
            ret, buffer = cv2.imencode('.jpg', frame)
            if ret:
                with frame_lock:
                    latest_frame = buffer.tobytes()
            
            # Tiny sleep to balance performance
            time.sleep(0.01)
            
        cap.release()

# Flask API Routing
@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/logout')
def do_logout_redirect():
    session.pop('logged_in', None)
    return redirect('/')

@app.route('/video_feed')
def video_feed():
    if not session.get('logged_in'):
        return "Unauthorized", 401
    def stream():
        while True:
            time.sleep(0.033)  # stream at ~30 FPS
            with frame_lock:
                if latest_frame is None:
                    continue
                frame_bytes = latest_frame
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
    return Response(stream(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/auth_status')
def auth_status():
    return jsonify({"logged_in": bool(session.get('logged_in'))})

@app.route('/api/login', methods=['POST'])
def do_login():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    password = data.get("password")
    
    with db_lock:
        users = state.get("users", {"admin": "admin"})
        
    if username and password and users.get(username) == password:
        session['logged_in'] = True
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Invalid credentials"}), 401

@app.route('/api/signup', methods=['POST'])
def do_signup():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    password = data.get("password")
    
    if not username or not password:
        return jsonify({"status": "error", "message": "Username and password are required"}), 400
        
    username = username.strip()
    password = password.strip()
    if len(username) < 3 or len(password) < 3:
        return jsonify({"status": "error", "message": "Username and password must be at least 3 characters"}), 400
        
    with db_lock:
        users = state.setdefault("users", {"admin": "admin"})
        if username in users:
            return jsonify({"status": "error", "message": "Username already exists"}), 400
        users[username] = password
        
    save_db()
    return jsonify({"status": "success", "message": "Account created successfully. You can now log in."})

@app.route('/api/reset_password', methods=['POST'])
def do_reset_password():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    security_key = data.get("security_key")
    new_password = data.get("new_password")
    
    if not username or not security_key or not new_password:
        return jsonify({"status": "error", "message": "All fields are required"}), 400
        
    username = username.strip()
    new_password = new_password.strip()
    if len(new_password) < 3:
        return jsonify({"status": "error", "message": "New password must be at least 3 characters"}), 400
        
    if security_key != "TRAFICAL_RECOVERY_2026":
        return jsonify({"status": "error", "message": "Invalid Security Recovery Key"}), 400
        
    with db_lock:
        users = state.get("users", {"admin": "admin"})
        if username not in users:
            return jsonify({"status": "error", "message": "Username not found"}), 404
        users[username] = new_password
        
    save_db()
    return jsonify({"status": "success", "message": "Password reset successfully. You can now log in."})

@app.route('/api/logout', methods=['POST'])
def do_logout():
    session.pop('logged_in', None)
    return jsonify({"status": "success"})

@app.route('/api/status', methods=['GET', 'POST'])
@login_required
def handle_status():
    """Get current vehicle status or POST new count from simulator"""
    if request.method == 'GET':
        return jsonify({
            "count": current_vehicle_count,
            "status": current_status
        })
    else:
        data = request.get_json(silent=True) or {}
        count = data.get("count")
        if count is not None:
            update_traffic_status(int(count))
            return jsonify({
                "status": "success",
                "count": current_vehicle_count,
                "traffic_status": current_status
            })
        return jsonify({"status": "error", "message": "Missing count parameter"}), 400

@app.route('/api/logs')
@login_required
def get_logs():
    """Retrieve last 10 SQLite logs"""
    try:
        conn = sqlite3.connect(SQLITE_DB)
        cursor = conn.cursor()
        cursor.execute("SELECT timestamp, vehicle_type, confidence FROM vehicle_logs ORDER BY id DESC LIMIT 10")
        rows = cursor.fetchall()
        conn.close()
        logs = [{"timestamp": r[0], "vehicle_type": r[1], "confidence": r[2]} for r in rows]
    except Exception as e:
        logs = []
        print(f"Error fetching logs from SQLite: {e}")
    return jsonify(logs)

@app.route('/api/stats')
@login_required
def get_stats():
    """Full dashboard counters and history graphs"""
    flow_rate = get_current_flow_rate()
    warning_active = (current_status == "Heavy") or (flow_rate > state["config"]["alert_threshold"])
    response_data = {
        "total_cars": state["total_cars"],
        "total_motos": state["total_motos"],
        "flow_rate": flow_rate,
        "current_vehicle_count": current_vehicle_count,
        "current_status": current_status,
        "warning_active": warning_active,
        "config": state["config"],
        "history": get_history_list()
    }
    return jsonify(response_data)

@app.route('/api/config', methods=['GET', 'POST'])
@login_required
def handle_config():
    if request.method == 'GET':
        return jsonify(state["config"])
        
    data = request.get_json(silent=True) or {}
    alert_threshold = data.get("alert_threshold")
    camera_url = data.get("camera_url")
    conf_threshold = data.get("conf_threshold")
    show_overlay = data.get("show_overlay")
    
    with db_lock:
        if alert_threshold is not None:
            state["config"]["alert_threshold"] = int(alert_threshold)
        if camera_url is not None:
            state["config"]["camera_url"] = str(camera_url)
        if conf_threshold is not None:
            state["config"]["conf_threshold"] = float(conf_threshold)
        if show_overlay is not None:
            state["config"]["show_overlay"] = bool(show_overlay)
            
    save_db()
    
    # Broadcast config change
    broadcast_event("config", state["config"])
    return jsonify({"status": "success", "config": state["config"]})

@app.route('/api/clear', methods=['POST'])
@login_required
def clear_data():
    global history_stats, detection_timestamps
    # Reset file-based db counters
    with db_lock:
        state["total_cars"] = 0
        state["total_motos"] = 0
    save_db()
    
    # Reset in-memory window and history stats
    with timestamps_lock:
        detection_timestamps.clear()
    with history_lock:
        history_stats.clear()
        
    # Clear SQLite database logs
    try:
        conn = sqlite3.connect(SQLITE_DB)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM vehicle_logs")
        cursor.execute("DELETE FROM traffic_density_logs")
        conn.commit()
        conn.close()
        print("SQLite databases cleared successfully.")
    except Exception as e:
        print(f"Error clearing SQLite databases: {e}")
        
    # Broadcast reset to all clients
    broadcast_payload = {
        "total_cars": 0,
        "total_motos": 0,
        "flow_rate": 0,
        "current_vehicle_count": 0,
        "current_status": "Light",
        "warning_active": False
    }
    # Reset local variables too
    update_traffic_status(0)
    broadcast_event("clear", broadcast_payload)
    
    return jsonify({"status": "success", "message": "All data cleared successfully"})

@app.route('/api/detection', methods=['GET', 'POST'])
def handle_detection():
    if request.method == 'GET':
        v_type = request.args.get('type')
    else:
        data = request.get_json(silent=True) or {}
        v_type = data.get('type')
        
    if v_type:
        success = add_detection(v_type)
        if success:
            return jsonify({"status": "success", "message": f"Added {v_type}"})
        else:
            return jsonify({"status": "error", "message": "Invalid type. Must be 'car' or 'moto'"}), 400
    else:
        return jsonify({"status": "error", "message": "Type parameter missing"}), 400

@app.route('/api/events')
def handle_events():
    if not session.get('logged_in'):
        return "Unauthorized", 401
    def event_generator():
        q = queue.Queue()
        with sse_lock:
            sse_clients.append(q)
            
        # Send initial state immediately
        flow_rate = get_current_flow_rate()
        init_data = {
            "total_cars": state["total_cars"],
            "total_motos": state["total_motos"],
            "flow_rate": flow_rate,
            "current_vehicle_count": current_vehicle_count,
            "current_status": current_status,
            "warning_active": (current_status == "Heavy"),
            "config": state["config"]
        }
        init_payload = json.dumps({"type": "init", "data": init_data})
        yield f"data: {init_payload}\n\n"
        
        try:
            while True:
                try:
                    # Timeout of 15 seconds to send ping
                    event = q.get(timeout=15)
                    yield f"data: {event}\n\n"
                except queue.Empty:
                    yield "data: {}\n\n"
        except GeneratorExit:
            pass
        finally:
            with sse_lock:
                if q in sse_clients:
                    sse_clients.remove(q)
                    
    return Response(event_generator(), mimetype='text/event-stream')

if __name__ == "__main__":
    load_db()
    init_db()
    
    # Start the YOLOv8 and camera processing background thread
    t = threading.Thread(target=yolo_thread_fn, daemon=True)
    t.start()
    
    print(f"Trafical server starting on http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
