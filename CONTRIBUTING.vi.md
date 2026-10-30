<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.vi.md)
<!-- doc-navigation:end -->

# Đóng góp

Cảm ơn bạn đã giúp cải thiện Team AI Box. Chúng tôi hoan nghênh những người đóng góp lần đầu: báo cáo lỗi, bản dịch, tài liệu, khả năng truy cập, tích hợp ứng dụng và thay đổi mã tập trung, tất cả đều được tính. Bạn không cần DGX Spark để cải thiện các tài liệu hoặc thành phần có thể được kiểm tra độc lập.

## Từ ý tưởng đến pull request

1. Tìm kiếm [sự cố hiện có](https://github.com/weerocksllc/teamaibox/issues). Mô tả vấn đề của người dùng, hành vi mong đợi, hành vi thực tế và phiên bản có liên quan. Thảo luận về những thay đổi lớn hơn trước khi đầu tư vào việc triển khai.
2. Phân nhánh kho lưu trữ công cộng và sao chép phân nhánh của bạn. Tạo một nhánh tập trung; không bao gồm trang web tiếp thị riêng, dữ liệu thời gian chạy hoặc mô hình đã tải xuống.
3. Theo dõi [BUILDING](docs/open-source/BUILDING.vi.md) để biết các bản dựng thành phần Node, pnpm và cục bộ. Trình cài đặt thiết bị mới là một quy trình công việc khác: không bao giờ chạy nó trên máy chứa dữ liệu kinh doanh chỉ để phát triển giao diện người dùng.
4. Thực hiện thay đổi mạch lạc nhỏ nhất, cập nhật tài liệu bị ảnh hưởng và tiến hành kiểm tra liên quan. Giải thích mọi hoạt động kiểm tra phụ thuộc vào phần cứng mà bạn không thể thực hiện.
5. Mở một yêu cầu kéo mô tả vấn đề, giải pháp, tác động và kiểm tra tính tương thích. Bao gồm các ảnh chụp màn hình đã được làm sạch để có những thay đổi rõ ràng. Trả lời phản hồi đánh giá; người bảo trì xem xét trước khi sáp nhập.

Không gian làm việc OpenSpec cục bộ là tùy chọn và không được xuất bản trong kho lưu trữ này. Những người đóng góp của công chúng có thể đưa trực tiếp đề xuất và tiêu chí chấp nhận vào một vấn đề hoặc PR; không thiếu thông số kỹ thuật riêng tư nào được yêu cầu để tham gia.

## Bản dịch và ảnh chụp màn hình

Tất cả 17 ngôn ngữ sản phẩm đều có README. Chỉnh sửa `docs/readme-locales/<locale>.json`, sau đó chạy `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. Không chỉnh sửa thủ công các README được tạo. Danh sách ngôn ngữ đến từ `packages/ui-system/src/locale-registry.mjs`. Hướng dẫn cài đặt, xây dựng, đóng góp, bảo mật và cấp phép được liên kết sử dụng cùng 17 ngôn ngữ. Danh sách tài liệu của họ ở dạng `docs/document-locales/manifest.json`. Chỉnh sửa bản dịch trang và đoạn văn ở ngôn ngữ nguồn trong `docs/document-locales/<locale>.json`, sau đó chạy `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. Khóa dịch là hàm băm SHA-256 của các đoạn nguồn; một thay đổi nguồn không thực hiện được trình kết xuất cho đến khi các bản dịch tương ứng được cập nhật. Các ví dụ về mã được chia sẻ nguyên văn và các liên kết tài liệu được tạo cho ngôn ngữ đã chọn. Các bản dịch mới là bản nháp được máy hỗ trợ với mã và liên kết được bảo vệ; việc xem xét ngôn ngữ và thuật ngữ đều được chào đón. Việc tạo và kiểm tra chạy cục bộ mà không cần dịch vụ dịch thuật, khóa API hoặc quyền truy cập vào công cụ. Xem [chính sách ảnh chụp màn hình](docs/assets/screenshots/README.vi.md) trước khi thêm hình ảnh công khai. Các bản dịch, bao gồm cả thuật ngữ và cách diễn đạt tự nhiên, đều được hoan nghênh đóng góp đánh giá.

## Quy tắc đóng góp

- Những đóng góp ban đầu được gửi theo giấy phép MIT của kho lưu trữ. Giữ nguyên tiêu đề của bên thứ ba và nêu rõ nguồn/giấy phép của tài liệu được sao chép. Không yêu cầu CLA bắt buộc riêng biệt hoặc quyền đóng góp trả phí.
- Sử dụng Nút 24 và phiên bản pnpm được ghim trong `package.json`. Yêu cầu về Python và Go được mô tả trong [BUILDING](docs/open-source/BUILDING.vi.md).
- Chỉ chạy các thử nghiệm liên quan đến thay đổi của bạn và báo cáo chính xác những gì đã chạy. Một thiết bị cố định cục bộ không phải là một tuyên bố chấp nhận thiết bị thực sự. Không lặp lại hoặc xóa các kết quả chấp nhận lịch sử chỉ để đóng thay đổi tài liệu.
- Không bao giờ kiểm tra việc xóa, cài đặt lại hoặc khôi phục dữ liệu của người dùng. Sử dụng đồ đạc tổng hợp hoặc tài nguyên tạm thời được chỉ định rõ ràng.
- Không có khóa riêng, mã thông báo, cookie, lời nhắc/tệp của khách hàng, hình ảnh khách đã đăng nhập, ảnh chụp nhanh triển khai riêng tư hoặc ảnh chụp màn hình cá nhân trong các vấn đề/PR. Xem [BẢO MẬT](SECURITY.vi.md) để biết báo cáo riêng tư.
- Giữ `private: true` trên các gói không gian làm việc. Không bao giờ viết lại lịch sử Git được chia sẻ, di chuyển thẻ phân phối hoặc xuất bản các tạo phẩm xây dựng riêng tư như một phần của hoạt động PR.

Ghi lại các thử nghiệm, di chuyển và thay đổi hành vi có liên quan trong đóng góp của bạn. Kiểm tra phụ thuộc vào phần cứng phải xác định cấu hình và giới hạn thực tế.
