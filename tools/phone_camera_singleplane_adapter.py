"""Narrow, deterministic adaptation for build 16102939's external Camera HAL.

The guest HAL accepts single-planar MJPEG, not upstream's multi-planar I420.
This candidate uses fixed, zero-padded MJPEG slots (width * height * 2 bytes).
No guest files or original upstream build are changed.
"""


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('camera_upstream_context_changed')
    return source.replace(old, new)


def adapt(name, source):
    if name == 'v4l2_stream_proxy/src/main.rs':
        source = replace_once(source, 'format: device::Format::Yuv420M,', 'format: device::Format::Mjpeg,')
        source = replace_once(source, 'Capabilities::VIDEO_CAPTURE_MPLANE | Capabilities::STREAMING',
                              'Capabilities::VIDEO_CAPTURE | Capabilities::STREAMING')
        source = replace_once(source, '        Ok(Config {', '''        if args.input_width < 32 || args.input_width > 1920
            || args.input_height < 32 || args.input_height > 1080
            || args.input_width % 2 != 0 || args.input_height % 2 != 0
            || fps_interval.0 == 0 || fps_interval.1 == 0
            || fps_interval.1 as u64 > 30 * fps_interval.0 as u64 {
            return Err(Error::InvalidArgument("unsupported camera dimensions or rate".into()));
        }
        Ok(Config {''')
    elif name == 'v4l2_stream_proxy/src/device.rs':
        start = source.index('#[derive(Clone, Copy, Debug, PartialEq, Eq)]\npub enum Format')
        end = source.index('/// Current status of a buffer.', start)
        source = source[:start] + '''#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format { Mjpeg }

impl Format {
    pub fn as_str(&self) -> &'static str { "MJPEG" }
    pub fn fourcc(&self) -> u32 { PixelFormat::from_fourcc(b"MJPG").to_u32() }
    pub fn plane_sizes(&self, width: u32, height: u32) -> Vec<usize> {
        vec![width as usize * height as usize * 2]
    }
}

''' + source[end:]
        source = replace_once(source, 'QueueType::VideoCaptureMplane', 'QueueType::VideoCapture')
        start = source.index('    fn default_fmt(&self, queue: QueueType) -> v4l2_format {')
        end = source.index('    fn default_fmtdesc(', start)
        source = source[:start] + '''    fn default_fmt(&self, queue: QueueType) -> v4l2_format {
        let pix = bindings::v4l2_pix_format {
            width: self.config.input_width,
            height: self.config.input_height,
            pixelformat: self.config.format.fourcc(),
            field: bindings::v4l2_field_V4L2_FIELD_NONE,
            colorspace: bindings::v4l2_colorspace_V4L2_COLORSPACE_JPEG,
            bytesperline: 0,
            sizeimage: self.config.format.plane_sizes(self.config.input_width, self.config.input_height)[0] as u32,
            ..Default::default()
        };
        v4l2_format { type_: queue as u32, fmt: bindings::v4l2_format__bindgen_ty_1 { pix } }
    }

''' + source[end:]
        source = replace_once(source, '        fmtdesc.type_ = queue as u32;',
                              '        fmtdesc.type_ = queue as u32;\n        fmtdesc.flags = bindings::V4L2_FMT_FLAG_COMPRESSED;')
        source += '''
#[cfg(test)]
mod single_plane_tests {
    use super::*;
    #[test]
    fn jpeg_has_one_bounded_plane() {
        assert_eq!(Format::Mjpeg.plane_sizes(640,480), vec![614400]);
        assert_eq!(Format::Mjpeg.fourcc(), u32::from_le_bytes(*b"MJPG"));
    }
    #[test]
    fn single_plane_mmap_buffer_has_storage() {
        let mut b=V4l2Buffer::new(QueueType::VideoCapture,0,MemoryType::Mmap);
        if let V4l2PlanesWithBackingMut::Mmap(mut p)=b.planes_with_backing_iter_mut() {
            let mut plane=p.next().unwrap();
            *plane.length=614400;
            plane.set_mem_offset(4096);
            assert!(p.next().is_none());
        } else { panic!("mmap buffer missing"); }
    }
}
'''
    return source
