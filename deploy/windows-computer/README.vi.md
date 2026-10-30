<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.vi.md)
<!-- doc-navigation:end -->

# Thời gian chạy máy tính ảo ARM

`Public.Dockerfile` xây dựng khả năng hiện diện vật lý (PPI) ARM TPM tương tự theo yêu cầu của thời gian chạy `windows-arm64-ppi` ban đầu. Nó xây dựng QEMU 11.1.1 từ bản phát hành chính thức sau khi xác minh chữ ký tách rời của nó dựa trên dấu vân tay của người quản lý phát hành được ghim. Debian cung cấp các thư viện và công cụ chứa chứ không phải tệp thực thi QEMU được sử dụng để chạy khách.

Không thay thế tệp thực thi này bằng gói QEMU phân phối cũ hơn. Cấu hình Windows kích hoạt `tpm-tis-device,...,ppi=on`; bản dựng không có thuộc tính ARM đó sẽ thoát trước khi chương trình cơ sở khởi động. Việc xóa `ppi=on`, vô hiệu hóa TPM hoặc đặt lại TPM của khách không phải là cách sửa chữa tương thích.

Bản dựng hình ảnh cuối cùng sẽ kiểm tra sự hỗ trợ của ARM TIS PPI và PulseAudio, đồng thời bao gồm ROM bộ đệm khung RAM phù hợp. Trên máy chủ ARM KVM, gói `python3 /usr/local/bin/probe-ppi` được đóng gói thực hiện kiểm tra QEMU/TPM không cần ổ đĩa, bị tạm dừng. Nó không gắn các đĩa khách hiện có hoặc chứng minh rằng quá trình cài đặt Windows đã hoàn tất. Việc khởi động Windows phải được kiểm tra riêng trên máy khách thử nghiệm được chỉ định rõ ràng.

Đối với bản cài đặt hiện có, hãy sử dụng chính sách cập nhật thời gian chạy của nền tảng và bản tóm tắt hình ảnh hồ sơ Tác nhân Nút phù hợp. Bảo toàn đĩa, chương trình cơ sở, danh tính và trạng thái TPM. Không tạo lại máy khách hoặc thay đổi hình ảnh máy khách Linux đang chạy chỉ để sửa chữa thời gian chạy Windows. Ghi lại các hình ảnh được tạo cục bộ dưới dạng chưa được xuất bản cho đến khi các thay đổi về nguồn của chúng được cam kết và phát hành.

Giữ quyền sở hữu cấu hình đã cài đặt và quyền đọc khi cập nhật cấu hình đó. Nếu API nền tảng được tạo lại để tải chính sách cập nhật thời gian chạy, thì cũng tạo lại các phần phụ thuộc không gian tên mạng (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` và `maintenance-controller`) từ hình ảnh không thay đổi của chúng. Họ phải tham gia không gian tên mạng của bộ chứa API mới. Đây không phải là hoạt động khởi động lại của khách, daemon Docker hoặc nhân viên AI. Đợi nhịp tim được xác thực bình thường của nút khôi phục trạng thái sẵn sàng trước khi gửi thao tác khởi động Windows.
