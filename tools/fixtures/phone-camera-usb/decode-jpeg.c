/* Diagnostic only: decode stdin frames with the guest's own libyuv. No files,
 * image output, hashes, microphone or network. One bounded frame at a time. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <unistd.h>
typedef int (*decode_fn)(const uint8_t*,size_t,uint8_t*,int,uint8_t*,int,uint8_t*,int,int,int,int,int);
static int exact(void *p,size_t n) {
  while(n){ssize_t r=read(0,p,n);if(r<=0)return 0;p=(char*)p+r;n-=r;}return 1;
}
int main(int argc,char **argv) {
  if(argc!=2)return 2;
  void *lib=dlopen(argv[1],RTLD_NOW);if(!lib){puts("{\"error\":\"decoder_load_failed\"}");return 3;}
  decode_fn decode=(decode_fn)dlsym(lib,"MJPGToI420");if(!decode)return 4;
  uint8_t *jpeg=malloc(640*480*2),*yuv=malloc(640*480*3/2);
  if(!jpeg||!yuv)return 5;
  for(int i=0;i<200;i++) {
    uint8_t h[4];if(!exact(h,4))break;
    uint32_t n=((uint32_t)h[0]<<24)|((uint32_t)h[1]<<16)|((uint32_t)h[2]<<8)|h[3];
    if(n<4||n>640*480*2||!exact(jpeg,n))return 6;
    int r=decode(jpeg,n,yuv,640,yuv+640*480,320,yuv+640*480*5/4,320,640,480,640,480);
    printf("{\"frame\":%d,\"bytes\":%u,\"decodeResult\":%d}\n",i,n,r);fflush(stdout);
  }
  memset(jpeg,0,640*480*2);memset(yuv,0,640*480*3/2);free(jpeg);free(yuv);dlclose(lib);return 0;
}
