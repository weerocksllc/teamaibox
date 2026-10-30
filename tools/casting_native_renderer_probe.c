/* Synthetic renderer startup, no AirPlay sender, network, or user media. */
#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include "renderers/video_renderer.h"
#include "renderers/audio_renderer.h"

static _Atomic unsigned long output_bytes;
static int submit_packet(AVCodecContext *codec, AVPacket *packet) {
    int count = 0;
    while (avcodec_receive_packet(codec, packet) == 0) {
        int length = packet->size, nals = 1;
        uint64_t stamp = (uint64_t)g_get_real_time() * 1000;
        video_renderer_render_buffer(packet->data, &length, &nals, &stamp);
        av_packet_unref(packet);
        g_usleep(34000);
        count++;
    }
    return count;
}

static int h264_synthetic(int width, int height, const char *format) {
    av_log_set_level(AV_LOG_ERROR);
    const AVCodec *encoder = avcodec_find_encoder_by_name("libx264");
    if (!encoder) return 0;
    AVCodecContext *codec = avcodec_alloc_context3(encoder);
    codec->width = width; codec->height = height;
    codec->pix_fmt = av_get_pix_fmt(format);
    codec->time_base = (AVRational){1, 30}; codec->framerate = (AVRational){30, 1};
    av_opt_set(codec->priv_data, "preset", "ultrafast", 0);
    av_opt_set(codec->priv_data, "tune", "zerolatency", 0);
    if (avcodec_open2(codec, encoder, NULL)) return 0;
    AVFrame *frame = av_frame_alloc();
    frame->format = codec->pix_fmt; frame->width = width; frame->height = height;
    if (av_frame_get_buffer(frame, 32)) return 0;
    AVPacket *packet = av_packet_alloc();
    int count = 0;
    for (int i = 0; i < 30; i++) {
        if (av_frame_make_writable(frame)) return 0;
        for (int p = 0; p < AV_NUM_DATA_POINTERS; p++)
            if (frame->buf[p]) memset(frame->buf[p]->data, 0, frame->buf[p]->size);
        frame->pts = i;
        if (avcodec_send_frame(codec, frame)) return 0;
        count += submit_packet(codec, packet);
    }
    avcodec_send_frame(codec, NULL);
    count += submit_packet(codec, packet);
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&codec);
    return count;
}
static gpointer drain(gpointer data) {
    int fd = GPOINTER_TO_INT(data);
    unsigned char scratch[65536];
    ssize_t n;
    while ((n = read(fd, scratch, sizeof(scratch))) > 0) output_bytes += n;
    close(fd);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "assert-probe") == 0) {
        g_usleep(10000000);
        g_assert(0);
    }
    bool sync = argc > 1;
    int sink = open("/dev/null", O_WRONLY), video[2];
    if (sink < 0 || dup2(sink, 5) != 5) return 2;
    if (sink != 5) close(sink);
    if (pipe(video)) return 2;
    int reader = fcntl(video[0], F_DUPFD_CLOEXEC, 10);
    int writer = fcntl(video[1], F_DUPFD_CLOEXEC, 10);
    close(video[0]); close(video[1]);
    if (reader < 0 || writer < 0 || dup2(writer, 4) != 4) return 2;
    close(writer);
    g_thread_new("synthetic-drain", drain, GINT_TO_POINTER(reader));
    if (!gstreamer_init()) return 3;
    logger_t *logger = logger_init();
    logger_set_level(logger, LOGGER_ERR);
    videoflip_t flip[2] = {NONE, NONE};
    const char *converter = "videoconvert ! videorate drop-only=true max-rate=30 ! video/x-raw,format=I420,framerate=30/1";
    char *expanded = g_strconcat(converter, " ! video/x-raw,colorimetry=sRGB,format=RGB  ! ", converter, NULL);
    bool upstream_srgb = getenv("TEAMAIBOX_SYNTHETIC_SRGB_EXPANSION") != NULL;
    video_renderer_init(logger, "Synthetic renderer probe", flip, "h264parse", "", "avdec_h264",
        upstream_srgb ? expanded : converter,
        "gdppay", " ! fdsink fd=4 sync=false", false, sync, false, false, 3, NULL);
    g_free(expanded);
    video_renderer_start();
    if (video_renderer_choose_codec(false, false) < 0) return 4;
    audio_renderer_init(logger, "gdppay ! fdsink fd=5 sync=false", &sync, &sync, "");
    unsigned char audio = 8;
    audio_renderer_start(&audio);
    puts("synthetic_native_renderers_started");
    GError *error = NULL;
    int width = argc > 2 ? atoi(argv[2]) : 640;
    int height = argc > 3 ? atoi(argv[3]) : 480;
    if (width < 16 || height < 16 || width > 1920 || height > 1920) return 8;
    if (argc > 4) {
        int frames = h264_synthetic(width, height, argv[4]);
        g_usleep(300000);
        printf("synthetic_h264_frames_submitted=%d output_bytes=%lu format=%s\n", frames, output_bytes, argv[4]);
        audio_renderer_stop(); video_renderer_stop();
        return frames == 30 && output_bytes > width * height ? 0 : 7;
    }
    char *launch = g_strdup_printf("videotestsrc num-buffers=30 ! video/x-raw,format=I420,width=%d,height=%d,framerate=30/1 ! openh264enc ! h264parse ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink name=encoded sync=false", width, height);
    GstElement *encoded = gst_parse_launch(launch, &error);
    g_free(launch);
    if (!encoded || error) return 5;
    GstElement *output = gst_bin_get_by_name(GST_BIN(encoded), "encoded");
    gst_element_set_state(encoded, GST_STATE_PLAYING);
    int frames = 0;
    for (;;) {
        GstSample *sample = gst_app_sink_try_pull_sample(GST_APP_SINK(output), GST_SECOND);
        if (!sample) break;
        GstMapInfo map;
        GstBuffer *buffer = gst_sample_get_buffer(sample);
        if (!gst_buffer_map(buffer, &map, GST_MAP_READ)) return 6;
        int length = (int)map.size, nals = 1;
        uint64_t stamp = (uint64_t)g_get_real_time() * 1000;
        video_renderer_render_buffer(map.data, &length, &nals, &stamp);
        gst_buffer_unmap(buffer, &map);
        gst_sample_unref(sample);
        frames++;
        g_usleep(34000);
    }
    g_usleep(300000);
    gst_element_set_state(encoded, GST_STATE_NULL);
    gst_object_unref(output);
    gst_object_unref(encoded);
    printf("synthetic_h264_frames_submitted=%d\n", frames);
    printf("synthetic_gdp_output_bytes=%lu\n", output_bytes);
    audio_renderer_stop();
    video_renderer_stop();
    return frames == 30 && output_bytes > width * height ? 0 : 7;
}
