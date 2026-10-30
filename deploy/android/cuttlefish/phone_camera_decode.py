#!/usr/bin/python3
"""One bounded still image to Camera HAL JPEG. No paths, sockets or recording.

Run as a short-lived child inside the existing phone cgroup. stdin is an
anonymous memory file; limits are set before importing image codecs.
"""
import io
import resource
import sys
import warnings

MAX_INPUT = 2**53 - 1
MAX_FRAME = 640 * 480 * 2


def decode(stream):
    sys.path.insert(0, '/opt/teamaibox/camera-python')
    from PIL import Image, ImageOps
    # Encoded file size and camera resolution are different concerns. JPEG can
    # decode a reduced-resolution image directly; PNG/WebP require work space.
    Image.MAX_IMAGE_PIXELS = None
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(stream, formats=['JPEG', 'PNG', 'WEBP']) as original:
            original.seek(0)
            original.draft('RGB', (1280, 960))
            address_limit = resource.getrlimit(resource.RLIMIT_AS)[0]
            if address_limit != resource.RLIM_INFINITY and original.width * original.height * 16 > address_limit:
                raise ValueError('phone_camera_image_memory_unavailable')
            # Respect the phone/photo's EXIF orientation; contain rather than
            # stretch/crop. Transparent areas and letterboxes become black.
            original.load()
            upright = ImageOps.exif_transpose(original)
            upright.thumbnail((640, 480), Image.Resampling.LANCZOS)
            rgba = upright.convert('RGBA')
            canvas = Image.new('RGB', (640, 480), 'black')
            canvas.paste(rgba, ((640-rgba.width)//2, (480-rgba.height)//2), rgba)
            output = io.BytesIO()
            # Fresh canvas strips source EXIF, location and text metadata.
            canvas.save(output, format='JPEG', quality=90, progressive=False, optimize=False)
            value = output.getvalue()
            if not 4 < len(value) <= MAX_FRAME:
                raise ValueError('phone_camera_frame_invalid')
            return value


def main():
    resource.setrlimit(resource.RLIMIT_AS, (384*1024**2, 384*1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        stream = sys.stdin.buffer
        stream.seek(0, 2)
        if not 0 < stream.tell() <= MAX_INPUT:
            return 1
        stream.seek(0)
        sys.stdout.buffer.write(decode(stream))
        return 0
    except Exception:
        # No source bytes, metadata, filenames or decoder errors are logged.
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
