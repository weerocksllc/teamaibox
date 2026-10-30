// Copyright 2026 Team AI Box contributors
// SPDX-License-Identifier: Apache-2.0
// A single bounded current-frame request, not a history of private camera frames.
use std::io::{self, Read, Write, Seek, SeekFrom};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use nix::sys::eventfd::EventFd;
use virtio_media::VirtioMediaEventQueue;
use virtio_media::protocol::{DequeueBufferEvent, V4l2Event};
use v4l2r::ioctl::V4l2PlanesWithBackingMut;
use crate::Config;
use crate::device::{BufferState, SessionState};

#[derive(Debug)]
pub(crate) enum WorkerCmd { Stop, BufferQueued }
pub(crate) struct WorkerHandle {
    pub(crate) tx: Sender<WorkerCmd>,
    pub(crate) event_fd: Arc<EventFd>,
    pub(crate) join_handle: JoinHandle<()>,
}

fn should_stop(rx:&Receiver<WorkerCmd>, event:&EventFd)->bool {
    let _=event.read();
    loop { match rx.try_recv() {
        Ok(WorkerCmd::Stop)|Err(TryRecvError::Disconnected)=>return true,
        Ok(WorkerCmd::BufferQueued)=>{},
        Err(TryRecvError::Empty)=>return false,
    }}
}

fn bounded_read(stream:&mut UnixStream, mut dest:&mut [u8], end:Instant)->io::Result<()> {
    while !dest.is_empty() {
        let remaining=end.checked_duration_since(Instant::now())
            .ok_or_else(||io::Error::from(io::ErrorKind::TimedOut))?;
        stream.set_read_timeout(Some(remaining))?;
        match stream.read(dest)? {
            0=>return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            n=>{dest=&mut dest[n..];}
        }
    }
    Ok(())
}

fn request_frame(stream:&mut UnixStream, maximum:usize)->io::Result<Vec<u8>> {
    stream.set_write_timeout(Some(Duration::from_millis(100)))?;
    stream.write_all(b"F")?;
    let end=Instant::now()+Duration::from_millis(250);
    let mut header=[0u8;4];bounded_read(stream,&mut header,end)?;
    let size=u32::from_be_bytes(header) as usize;
    if size<4||size>maximum {return Err(io::Error::from(io::ErrorKind::InvalidData));}
    let mut frame=vec![0;size];bounded_read(stream,&mut frame,end)?;
    if frame[..2]!=[0xff,0xd8]||frame[size-2..]!=[0xff,0xd9] {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(frame)
}

pub(crate) fn worker_thread_loop<Q:VirtioMediaEventQueue+Send+'static>(
    config:Config,evt_queue:Arc<Mutex<Q>>,session:Arc<Mutex<SessionState>>,
    rx:Receiver<WorkerCmd>,event:Arc<EventFd>,
) {
    let maximum=config.format.plane_sizes(config.input_width,config.input_height)[0];
    let mut stream=None;
    // Config has already rejected zero/out-of-range rates.
    let interval=Duration::from_secs_f64(config.fps_interval.0 as f64/config.fps_interval.1 as f64);
    let mut next=Instant::now();
    loop {
        if should_stop(&rx,&event) {return;}
        if session.lock().unwrap().queued_buffers.is_empty()||Instant::now()<next {
            std::thread::sleep(Duration::from_millis(10));continue;
        }
        if stream.is_none() {
            match UnixStream::connect(&config.input_path) {
                Ok(value)=>stream=Some(value),
                Err(_)=>{std::thread::sleep(Duration::from_millis(50));continue;}
            }
        }
        let frame=match request_frame(stream.as_mut().unwrap(),maximum) {
            Ok(value)=>value,
            Err(_)=>{stream=None;std::thread::sleep(Duration::from_millis(20));continue;}
        };
        if should_stop(&rx,&event) {return;}
        let outgoing={
            let mut state=session.lock().unwrap();
            let Some(index)=state.queued_buffers.pop_front() else {continue;};
            let sequence=state.sequence;state.sequence=state.sequence.wrapping_add(1);
            let id=state.id;let buffer=&mut state.buffers[index];
            let mut file=buffer.planes[0].fd.as_file();
            if file.seek(SeekFrom::Start(0)).and_then(|_|file.write_all(&frame)).is_err() {return;}
            buffer.set_state(BufferState::Outgoing{sequence});
            if let V4l2PlanesWithBackingMut::Mmap(mut planes)=buffer.v4l2_buffer.planes_with_backing_iter_mut() {
                if let Some(mut plane)=planes.next() {*plane.bytesused=frame.len() as u32;}
            }
            (id,buffer.v4l2_buffer.clone())
        };
        evt_queue.lock().unwrap().send_event(V4l2Event::DequeueBuffer(
            DequeueBufferEvent::new(outgoing.0,outgoing.1)));
        next=Instant::now()+interval;
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;
    fn reply(payload:Vec<u8>,declared:usize)->io::Result<Vec<u8>> {
        let (mut a,mut b)=UnixStream::pair().unwrap();
        let thread=std::thread::spawn(move||{
            let mut request=[0];b.read_exact(&mut request).unwrap();assert_eq!(request,b"F"[..]);
            b.write_all(&(declared as u32).to_be_bytes()).unwrap();let _=b.write_all(&payload);
        });
        let result=request_frame(&mut a,32);thread.join().unwrap();result
    }
    #[test]
    fn complete_bounded_frame() {assert_eq!(reply(vec![255,216,1,2,255,217],6).unwrap(),vec![255,216,1,2,255,217]);}
    #[test]
    fn oversized_frame_rejected_before_allocation() {assert!(reply(vec![],33).is_err());}
    #[test]
    fn truncated_or_invalid_frame_rejected() {
        assert!(reply(vec![255,216],6).is_err());assert!(reply(vec![0;6],6).is_err());
    }
}
