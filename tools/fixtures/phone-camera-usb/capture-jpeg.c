/* Disposable guest diagnostic. Reports framing/decoder counts, never pixels. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <poll.h>
#include <linux/videodev2.h>
typedef int (*decode_fn)(const uint8_t*,size_t,uint8_t*,int,uint8_t*,int,uint8_t*,int,int,int,int,int);
int main(int argc,char **argv) {
  if(argc!=2&&argc!=3)return 2;
  int hal_queue=argc==3&&!strcmp(argv[2],"hal-queue");
  int remap=hal_queue||(argc==3&&!strcmp(argv[2],"remap"));
  void *lib=dlopen(argv[1],RTLD_NOW);if(!lib)return 3;
  decode_fn decode=(decode_fn)dlsym(lib,"MJPGToI420");if(!decode)return 4;
  int fd=open("/dev/video1",O_RDWR|O_NONBLOCK|O_CLOEXEC);if(fd<0){perror("video1");return 5;}
  struct v4l2_format f={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE};
  f.fmt.pix.width=640;f.fmt.pix.height=480;f.fmt.pix.pixelformat=V4L2_PIX_FMT_MJPEG;
  f.fmt.pix.field=V4L2_FIELD_NONE;
  if(ioctl(fd,VIDIOC_S_FMT,&f))return 6;
  struct v4l2_requestbuffers req={.count=3,.type=V4L2_BUF_TYPE_VIDEO_CAPTURE,.memory=V4L2_MEMORY_MMAP};
  if(ioctl(fd,VIDIOC_REQBUFS,&req)||req.count<2||req.count>8)return 7;
  uint8_t *mem[8]={0},*yuv=malloc(640*480*3/2);size_t length[8]={0};if(!yuv)return 8;
  for(unsigned i=0;i<req.count;i++) {
    struct v4l2_buffer b={.index=i,.type=req.type,.memory=req.memory};
    if(ioctl(fd,VIDIOC_QUERYBUF,&b)||b.length>640*480*2)return 9;
    length[i]=b.length;
    if(!remap)mem[i]=mmap(0,b.length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,b.m.offset);
    if(mem[i]==MAP_FAILED||ioctl(fd,VIDIOC_QBUF,&b))return 10;
  }
  enum v4l2_buf_type type=req.type;if(ioctl(fd,VIDIOC_STREAMON,&type))return 11;
  int result=0;
  for(int i=0;i<45;i++) {
    struct pollfd p={.fd=fd,.events=POLLIN};if(poll(&p,1,2000)<=0){result=12;break;}
    struct v4l2_buffer b={.type=req.type,.memory=req.memory};
    if(ioctl(fd,VIDIOC_DQBUF,&b)||b.index>=req.count||b.bytesused>length[b.index]){result=13;break;}
    uint8_t *data=remap?mmap(0,b.bytesused,PROT_READ,MAP_SHARED,fd,b.m.offset):mem[b.index];
    if(data==MAP_FAILED){result=15;break;}
    size_t mapped=remap?b.bytesused:length[b.index];int end=-1;
    for(size_t j=1;j<mapped;j++)if(data[j-1]==255&&data[j]==217){end=(int)j+1;break;}
    int r=decode(data,b.bytesused,yuv,640,yuv+640*480,320,yuv+640*480*5/4,320,640,480,640,480);
    int rfull=decode(data,mapped,yuv,640,yuv+640*480,320,yuv+640*480*5/4,320,640,480,640,480);
    printf("{\"frame\":%d,\"index\":%u,\"offset\":%u,\"bytesused\":%u,\"capacity\":%zu,\"firstEnd\":%d,\"decodeResult\":%d,\"fullDecodeResult\":%d}\n",i,b.index,b.m.offset,b.bytesused,length[b.index],end,r,rfull);fflush(stdout);
    if(remap)munmap(data,mapped);
    /* Android's HAL returns only type, memory and index, as V4L2 permits. */
    if(hal_queue){unsigned index=b.index;memset(&b,0,sizeof(b));b.type=req.type;b.memory=req.memory;b.index=index;}
    if(ioctl(fd,VIDIOC_QBUF,&b)){result=14;break;}
  }
  ioctl(fd,VIDIOC_STREAMOFF,&type);
  for(unsigned i=0;i<req.count;i++)if(mem[i])munmap(mem[i],length[i]);
  req.count=0;ioctl(fd,VIDIOC_REQBUFS,&req);close(fd);memset(yuv,0,640*480*3/2);free(yuv);dlclose(lib);return result;
}
