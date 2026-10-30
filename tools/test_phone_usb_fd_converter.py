"""Real codec geometry checks using generated pixels, not a physical camera."""
import io
import sys
from pathlib import Path
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish'))
from PIL import Image, ImageDraw
from phone_usb_camera_fd_source import UsbFrameConverter


class ConverterTests(unittest.TestCase):
    def test_landscape_portrait_and_square_keep_square_geometry(self):
        for width,height in ((1280,720),(480,800),(800,600)):
            with self.subTest(size=(width,height)):
                image=Image.new('RGB',(width,height),(0,100,150))
                ImageDraw.Draw(image).rectangle((width//2-50,height//2-50,width//2+49,height//2+49),fill=(250,0,0))
                raw=io.BytesIO();image.save(raw,format='JPEG',quality=95)
                decoder=UsbFrameConverter(dict(pixelFormat='MJPG',width=width,height=height,frameRate=[30,1]))
                try:result=decoder.convert(raw.getvalue(),1,threading.Event())
                finally:decoder.close()
                encoded=Image.open(io.BytesIO(result))
                self.assertEqual(encoded.layer,[(1,2,2,0),(2,1,1,1),(3,1,1,1)],
                    'Camera HAL needs YCbCr 4:2:0 MJPEG, not Adobe RGB JPEG')
                self.assertNotEqual(encoded.info.get('adobe_transform'),0)
                output=encoded.convert('RGB')
                self.assertEqual(output.size,(640,480))
                pixels=list(output.getdata())
                points=[(i%640,i//640) for i,(r,g,b) in enumerate(pixels) if r>180 and g<60 and b<60]
                x0,x1=min(p[0] for p in points),max(p[0] for p in points)
                y0,y1=min(p[1] for p in points),max(p[1] for p in points)
                self.assertLessEqual(abs((x1-x0)-(y1-y0)),2)
                expected=100*min(640/width,480/height)
                self.assertLess(abs(x1-x0+1-expected),4)
                if width/height>4/3:self.assertLess(max(output.getpixel((320,0))),10)
                if width/height<4/3:self.assertLess(max(output.getpixel((0,240))),10)
    def test_yuyv_converts_to_jpeg_without_color_swap(self):
        decoder=UsbFrameConverter(dict(pixelFormat='YUYV',width=640,height=480,frameRate=[30,1]))
        try:result=decoder.convert(bytes((180,128,180,128))*(640*480//2),1,threading.Event())
        finally:decoder.close()
        output=Image.open(io.BytesIO(result)).convert('RGB')
        pixel=output.getpixel((320,240))
        self.assertLess(max(pixel)-min(pixel),5)
        self.assertTrue(150<min(pixel)<230)


if __name__=='__main__':unittest.main()
