import urllib.request
import json
import time
import random
import sys

PORT = 8000
BASE_URL = f"http://localhost:{PORT}/api/detection"

def send_detection(vehicle_type):
    url = f"{BASE_URL}?type={vehicle_type}"
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req) as response:
            res_data = response.read().decode('utf-8')
            print(f"Sent {vehicle_type} webhook. Server Response: {res_data}")
    except Exception as e:
        print(f"Failed to trigger webhook for {vehicle_type}: {e}", file=sys.stderr)

def main():
    print("Starting automated traffic webhook simulation...")
    print(f"Target endpoint: {BASE_URL}")
    print("Press Ctrl+C to stop.")
    
    vehicles = ["car", "moto"]
    try:
        while True:
            # Randomly select a vehicle type
            v_type = random.choice(vehicles)
            send_detection(v_type)
            
            # Sleep randomly between 1 to 5 seconds to simulate traffic flow
            sleep_time = random.uniform(1.0, 5.0)
            time.sleep(sleep_time)
    except KeyboardInterrupt:
        print("\nSimulation stopped.")

if __name__ == "__main__":
    main()
