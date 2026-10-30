"""Do not advertise the host's uptime as the Android guest's capture clock."""
def adapt(name, source):
    if name != 'v4l2_stream_proxy/src/device.rs':
        return source
    start = source.index('                let mut ts = libc::timespec {')
    end = source.index('                Self::unset_flag(&mut flags, BufferFlags::QUEUED);', start)
    source = source[:start] + '''                // Host and guest CLOCK_MONOTONIC have different epochs.
                // UNKNOWN lets Android timestamp receipt using its own clock.
                self.v4l2_buffer.set_timestamp(bindings::timeval {
                    tv_sec: 0,
                    tv_usec: 0,
                });
''' + source[end:]
    before = 'v4l2_buffer.set_flags(BufferFlags::TIMESTAMP_MONOTONIC);'
    if source.count(before) != 1:
        raise RuntimeError('clock_flag_context_changed')
    source = source.replace(before, 'v4l2_buffer.set_flags(BufferFlags::empty());')
    return source + '''
#[cfg(test)]
mod guest_clock_tests {
    use super::*;
    #[test]
    fn outgoing_frame_does_not_claim_host_time_is_guest_time() {
        let mut buffer = Buffer::new(
            V4l2Buffer::new(QueueType::VideoCapture,0,MemoryType::Mmap), vec![]);
        buffer.set_state(BufferState::Incoming);
        buffer.set_state(BufferState::Outgoing{sequence:1});
        assert!(!buffer.v4l2_buffer.flags().contains(BufferFlags::TIMESTAMP_MONOTONIC));
        assert_eq!(buffer.v4l2_buffer.timestamp().tv_sec, 0);
        assert_eq!(buffer.v4l2_buffer.timestamp().tv_usec, 0);
    }
}
'''
