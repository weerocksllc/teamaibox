"""Same 6 GiB phone budget/pressure guard, separate USB qualification identity."""
import re
import phone_camera_product_resource_guard as guard

guard.RUN_ID = re.compile(r'phone-camera-usb-hal-\d{8}-a[1-9][0-9]*')
if __name__ == '__main__':
    raise SystemExit(guard.main())
