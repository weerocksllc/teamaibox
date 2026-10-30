"""Render a new, non-sensitive deterministic OCR test card (not user media)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parents[1]/'tmp/postboot-ocr-fixture-20260907-a1.png'
assert not out.exists()
image = Image.new('RGB', (1000, 440), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 44)
for y, line in [(50, 'TEAM AI BOX'), (140, 'Office recovery check'), (230, 'Meeting at 3 PM'), (320, 'Document number 20260907')]:
    draw.text((55, y), line, fill='black', font=font)
image.save(out)
print(out)
