#!/usr/bin/python3
"""Single USB decoder in the phone cgroup; same supervised lifetime as video."""
import json
from phone_camera_input import CameraInputError
from phone_usb_camera_devices import UsbCameraError
from phone_usb_camera_session import UsbCameraSession, validate_start
from phone_video_camera_worker import main


if __name__ == '__main__':
    try:
        raise SystemExit(main(UsbCameraSession, validate_start))
    except Exception as error:
        code = str(error) if isinstance(error, (CameraInputError, UsbCameraError)) else 'phone_camera_runtime_unavailable'
        print(json.dumps({'errorCode': code}), flush=True)
        raise SystemExit(1)
