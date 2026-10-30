#!/usr/bin/python3
"""Candidate camera input lifetime follows this VM; no host process management."""
import ctypes
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from phone_camera_crosvm_base import media_arguments, REAL, BACKEND, DIRECTORY, SOCKET


def main():
    args,media=media_arguments(sys.argv[1:])
    if not media:os.execv(REAL,[REAL,*args])
    if os.getuid()!=10001:raise RuntimeError('camera_candidate_uid_invalid')
    DIRECTORY.mkdir(mode=0o700,exist_ok=True);info=DIRECTORY.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=10001 or stat.S_IMODE(info.st_mode)!=0o700:
        raise RuntimeError('camera_candidate_directory_invalid')
    for path in (SOCKET,DIRECTORY/'frames.sock',DIRECTORY/'control.sock'):
        if path.exists() or path.is_symlink():raise RuntimeError('camera_candidate_socket_occupied')
    parent=os.getpid();children=[]
    def parent_death():
        if ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGTERM,0,0,0)!=0 or os.getppid()!=parent:os._exit(1)
    def launch(command,logname):
        with (DIRECTORY/logname).open('xb') as log:
            child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log,preexec_fn=parent_death)
        children.append(child)
    try:
        launch(['python3','-B','/opt/teamaibox/phone_camera_input.py'],'input.log')
        launch([BACKEND,'--socket-path',str(SOCKET),'--verbosity','warn','--input_path',str(DIRECTORY/'frames.sock'),
                '--input_width','640','--input_height','480','--input_fps','15'],'backend.log')
        deadline=time.monotonic()+5
        paths=(SOCKET,DIRECTORY/'frames.sock',DIRECTORY/'control.sock')
        while not all(p.exists() for p in paths) and all(c.poll() is None for c in children) and time.monotonic()<deadline:time.sleep(.05)
        if any(c.poll() is not None for c in children) or not all(p.exists() and stat.S_ISSOCK(p.lstat().st_mode) for p in paths):
            raise RuntimeError('camera_candidate_source_not_ready')
        os.execv(REAL,[REAL,*args])
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)


if __name__=='__main__':main()
