<!-- Generated from docs/readme-locales/ and docs/readme-features/vi.json by tools/render-readmes.mjs. -->
# Team AI Box — Phần mềm nguồn mở cho NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Biến NVIDIA DGX Spark thành không gian AI của cả nhóm.** Chạy AI cục bộ, tạo ảnh và công cụ tài liệu trên NVIDIA DGX Spark. Team AI Box kết hợp tệp nhóm, nhắn tin và thiết bị ảo trong một không gian làm việc nguồn mở trên trình duyệt.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Danh sách đầy đủ các tính năng](#features) · [Cài trên DGX Spark mới](#install) · [Cùng đóng góp](#contribute)

## Vì sao chọn Team AI Box?

- **Không gian thống nhất:** giao diện và tài khoản chung cho AI, cộng tác và thiết bị.
- **Ưu tiên AI cục bộ.** Chạy suy luận mô hình trên Spark và kết nối API mô hình bên ngoài khi cần.
- **Được thiết kế cho DGX Spark.** Cài trên Ubuntu ARM64 với container GPU NVIDIA và ảo hóa KVM.
- **Mở để cùng cải tiến:** mã gốc MIT, 17 ngôn ngữ, giao diện sáng/tối và ghi nhớ lựa chọn thủ công. Mặc định là tiếng Anh.

## Không gian làm việc thực tế

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/vi/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/vi/workbench-light.jpg">
  <img src="docs/assets/screenshots/vi/workbench-light.jpg" alt="Không gian Team AI Box cho NVIDIA DGX Spark với ứng dụng AI và công cụ nhóm — Tiếng Việt" width="1280">
</picture>

[Giao diện sáng](docs/assets/screenshots/vi/workbench-light.jpg) · [Giao diện tối](docs/assets/screenshots/vi/workbench-dark.jpg)

<a id="features"></a>

## Danh sách đầy đủ các tính năng

**Chuyển đến mô-đun**

- [Không gian làm việc và điều hướng hằng ngày](#feature-workspace)
- [Trợ lý AI và quy trình Agent có kiểm soát](#feature-assistant)
- [Tạo ảnh bằng AI](#feature-drawing)
- [Nhận dạng và hiệu đính văn bản](#feature-ocr)
- [Chuyển lời nói từ bản ghi và trực tiếp thành văn bản](#feature-transcription)
- [Dịch văn bản, tệp và nội dung đa phương tiện](#feature-translation)
- [Nhắn tin trong nhóm](#feature-messaging)
- [Ổ đĩa nhóm và cộng tác tệp](#feature-drive)
- [Trình chiếu không dây tương thích AirPlay](#feature-casting)
- [Điện thoại Android ảo lưu dữ liệu lâu dài](#feature-phones)
- [Máy tính Windows và Linux ảo](#feature-computers)
- [Quản trị, phân quyền và bảo mật](#feature-administration)
- [Cài đặt từ mã nguồn và bảo trì](#feature-installation)
- [Phát triển mã nguồn mở và phần mở rộng](#feature-developers)

<a id="feature-workspace"></a>

### Không gian làm việc và điều hướng hằng ngày

- Dùng một không gian làm việc trên trình duyệt cho AI cục bộ, cộng tác nhóm và thiết bị ảo trên một DGX Spark duy nhất.
- Duyệt ứng dụng theo danh mục, tìm trong danh mục ứng dụng và mở ứng dụng từ thanh bên.
- Xem tiến độ tải, khả năng sử dụng và trạng thái dịch vụ của từng ứng dụng.
- Theo dõi công việc đang xếp hàng, đang chạy, hoàn tất, thất bại và đã hủy trong trung tâm tác vụ; mở các kết quả có sẵn.
- Xem lời mời trình chiếu đang chờ trong menu thông báo và mở ứng dụng trình chiếu để phản hồi.
- Chọn trong 17 ngôn ngữ giao diện, bao gồm tiếng Ả Rập viết từ phải sang trái; tiếng Anh là mặc định cho đến khi bạn chọn ngôn ngữ khác.
- Dùng giao diện sáng, tối hoặc theo hệ thống; lựa chọn ngôn ngữ và giao diện thủ công được giữ nguyên khi tải lại trang, đăng nhập lại và chuyển giữa các ứng dụng.

<a id="feature-assistant"></a>

### Trợ lý AI và quy trình Agent có kiểm soát

- Bắt đầu cuộc trò chuyện, lưu lịch sử và mở lại các cuộc trao đổi trước đây.
- Chọn chế độ Tự động, Trả lời hoặc Agent cho yêu cầu hiện tại.
- Đính kèm nhiều tệp vào một yêu cầu và bỏ tệp đính kèm trước khi gửi.
- Đọc câu trả lời được truyền dần, dừng lượt chạy đang hoạt động và tiếp tục luồng sự kiện sau khi kết nối lại.
- Xem chi tiết mô hình, hoạt động công cụ, nguồn và thông tin sử dụng được trả về; tải xuống các tệp đầu ra khi lượt chạy tạo ra chúng.
- Xem phạm vi của thao tác Agent cần xác nhận, sau đó chấp thuận hoặc từ chối thao tác đó.
- Chạy công việc Agent trong môi trường cách ly riêng cho từng người dùng với không gian làm việc lâu dài; công cụ và quyền truy cập mạng tuân theo chính sách của quản trị viên.

<a id="feature-drawing"></a>

### Tạo ảnh bằng AI

- Tạo ảnh từ mô tả văn bản bằng mô hình ảnh có sẵn; ứng dụng hiện tại không phải trình chỉnh sửa ảnh hoặc chỉnh sửa vùng ảnh bằng inpainting.
- Chọn cách tạo Tự động hoặc Nhanh khi cấu hình mô hình hiện có hỗ trợ.
- Chọn tỷ lệ vuông, ngang hoặc dọc, kích thước đầu ra được hỗ trợ và seed ngẫu nhiên hoặc cố định.
- Yêu cầu đầu ra PNG, WebP hoặc JPEG, xem trước kết quả và tải ảnh xuống.
- Theo dõi hàng đợi và tiến độ tạo ảnh, hủy công việc và khôi phục tác vụ hiện tại sau khi mở lại trang.
- Xem mô hình thực tế và các tham số tạo ảnh được lưu cùng kết quả.

<a id="feature-ocr"></a>

### Nhận dạng và hiệu đính văn bản

- Tải lên PNG, JPEG, WebP hoặc PDF, hoặc chọn tệp có sẵn từ ổ đĩa nhóm.
- Cung cấp gợi ý ngôn ngữ và nhận dạng văn bản, bảng Markdown hoặc công thức LaTeX trong phạm vi khả năng của mô hình được chọn.
- Xem kết quả nhận dạng theo trang và khối văn bản, sau đó sửa thủ công văn bản đã nhận dạng.
- Xuất nội dung đã hiệu đính dưới dạng văn bản, Markdown hoặc JSON.
- Chuyển kết quả nhận dạng đã lưu sang ứng dụng Dịch mà không phải tải lên và nhận dạng lại nguồn.
- Theo dõi và hủy tác vụ nhận dạng. Mô hình hiện tại không cung cấp tọa độ khung bao hoặc điểm tin cậy.

<a id="feature-transcription"></a>

### Chuyển lời nói từ bản ghi và trực tiếp thành văn bản

- Chọn âm thanh/video cục bộ hoặc từ ổ đĩa nhóm: WAV, FLAC, OGG, WebM, MP3, M4A, AIFF hoặc MP4.
- Xem hoặc nghe trước nội dung nguồn và dùng tính năng tự nhận diện ngôn ngữ hoặc gợi ý một ngôn ngữ được hỗ trợ.
- Xem các đoạn văn bản có mốc thời gian và chỉnh sửa nội dung.
- Xuất văn bản, JSON hoặc phụ đề SRT và WebVTT.
- Chuyển bản chép lời đã lưu sang ứng dụng Dịch và theo dõi hoặc hủy tác vụ chép lời hiện tại.
- Chép lời từ micrô trực tiếp khi có HTTPS, quyền của trình duyệt, MediaRecorder và dịch vụ thời gian thực.
- Chỉ dùng mốc thời gian từng từ hoặc phân tách người nói với hồ sơ được hỗ trợ; luồng phân tách người nói thử nghiệm yêu cầu đầu vào WAV.

<a id="feature-translation"></a>

### Dịch văn bản, tệp và nội dung đa phương tiện

- Chọn từ danh mục 60 ngôn ngữ mà mô hình hỗ trợ, tự nhận diện ngôn ngữ nguồn, hoặc chọn và hoán đổi ngôn ngữ nguồn/đích. Điều này không cam kết chất lượng đồng đều cho mọi cặp ngôn ngữ.
- Dịch văn bản nhập hoặc dán vào và so sánh các đoạn nguồn với bản dịch.
- Tải lên ảnh hoặc PDF, hoặc chọn từ ổ đĩa nhóm; nhận dạng văn bản trước khi dịch khi OCR đã sẵn sàng.
- Dịch âm thanh/video được hỗ trợ thông qua chép lời, giữ mốc thời gian của các đoạn khi dịch vụ chép lời đã sẵn sàng.
- Dùng lại kết quả OCR/chép lời đã lưu và tải xuống các kết quả trung gian có sẵn.
- Chỉnh sửa bản dịch và xuất thành văn bản, Markdown hoặc JSON; kết quả âm thanh/video còn hỗ trợ SRT và WebVTT.
- Theo dõi các bước trích xuất, chép lời và dịch, hủy công việc và khôi phục tác vụ hiện tại sau khi mở lại trang.
- Ngôn ngữ dịch độc lập với ngôn ngữ giao diện và phạm vi ngôn ngữ OCR/ASR. Dịch PDF xử lý văn bản, không tái tạo bố cục gốc hay cung cấp chức năng chỉnh sửa DOCX/XLSX tổng quát.

<a id="feature-messaging"></a>

### Nhắn tin trong nhóm

- Tìm đồng đội, bắt đầu trò chuyện riêng và tạo nhóm trò chuyện có tên với các thành viên đã chọn.
- Lọc tất cả cuộc trò chuyện, chưa đọc hoặc trò chuyện nhóm và tìm trong các cuộc trò chuyện/tin nhắn bạn được phép truy cập.
- Gửi văn bản và tệp đính kèm; tải xuống phiên bản tệp gốc của tệp đính kèm.
- Nhận tin nhắn trực tiếp, truy cập lại lịch sử khi kết nối lại, theo dõi vị trí đã đọc/chưa đọc và xem trạng thái hiện diện của thành viên.
- Nhấn Enter để gửi, Shift+Enter để xuống dòng và chuyển giữa danh sách cuộc trò chuyện với nội dung chat trên màn hình hẹp.
- Xóa tin nhắn khỏi phần hiển thị của riêng bạn hoặc xóa lịch sử trò chuyện của bạn; bản ghi của những người tham gia khác không bị xóa.
- Xóa cuộc trò chuyện khỏi danh sách riêng của bạn mà không rời nhóm; tin nhắn mới có thể khiến cuộc trò chuyện xuất hiện lại.

<a id="feature-drive"></a>

### Ổ đĩa nhóm và cộng tác tệp

- Sắp xếp không gian tệp cá nhân và nhóm bằng thư mục và điều hướng theo đường dẫn.
- Chuyển giữa dạng danh sách/lưới, xem chi tiết tệp, tìm tệp/thư mục và xem thay đổi gần đây.
- Tải lên nhiều tệp, theo dõi tiến độ và hủy lượt tải lên.
- Tiếp tục tải tệp lớn theo nhiều phần bằng cách chọn lại đúng tệp đó; máy chủ xác minh những phần đã tải lên.
- Tạo thư mục và đổi tên, di chuyển hoặc sao chép tệp và thư mục.
- Xem trước ảnh, âm thanh, video, văn bản và PDF được hỗ trợ, đồng thời tải tệp xuống; khả năng phát nội dung đa phương tiện phụ thuộc vào trình duyệt.
- Tải lên phiên bản mới của tệp, xem lịch sử phiên bản và tải xuống phiên bản cũ.
- Chuyển mục vào thùng rác và khôi phục chúng.
- Chia sẻ nội bộ với thành viên hoặc nhóm bằng quyền xem/chỉnh sửa và thời hạn tùy chọn; đây không phải chia sẻ liên kết công khai ẩn danh.
- Duyệt tệp và thư mục được chia sẻ với bạn; quyền truy cập được kiểm tra lại theo quyền hạn và tư cách thành viên hiện tại.

<a id="feature-casting"></a>

### Trình chiếu không dây tương thích AirPlay

- Khởi động và dừng bộ thu tạm thời cho thiết bị Apple tương thích trong cùng mạng LAN, với tên bộ thu và mã PIN riêng.
- Chọn thời hạn bộ thu là 15, 30, 60 hoặc 120 phút; dừng hoặc hết hạn sẽ kết thúc phát và quyền xem.
- Giới hạn người xem là chính bạn, các thành viên được chọn hoặc một nhóm; mời người xem và cho phép họ chấp nhận hoặc từ chối.
- Xem màn hình và nghe âm thanh trong trình duyệt; quy tắc tự phát của trình duyệt có thể yêu cầu nhấp để bật tiếng.
- Xem và xóa người xem đang kết nối; quản trị viên có thể dừng phiên mà không được cấp quyền xem nội dung riêng tư.
- Xem trạng thái ngắt/kết nối lại; quyền xem được kiểm tra lại khi tham gia lại.
- Yêu cầu môi trường chạy đa phương tiện sẵn sàng, khả năng phát hiện trên LAN thông suốt và phiên bản trình duyệt/thiết bị tương thích. Xem qua trình duyệt không cung cấp đầu ra HDMI, phát DRM/FairPlay hay chứng nhận Apple.

<a id="feature-phones"></a>

### Điện thoại Android ảo lưu dữ liệu lâu dài

- Tạo điện thoại Android độc lập từ hồ sơ hệ thống đã cài, giữ ứng dụng và dữ liệu của từng điện thoại qua các phiên.
- Khởi động, tắt, khởi động lại, đổi tên và chủ động xác nhận xóa từng điện thoại.
- Điều khiển Android bằng bàn phím/con trỏ và các nút Quay lại, Màn hình chính, Ứng dụng gần đây và âm lượng.
- Dùng âm thanh và chế độ toàn màn hình, kết nối lại hoặc chuyển kết nối điện thoại đang hoạt động sang trang khác.
- Tải tệp lên điện thoại và tải tệp xuống từ thư mục trao đổi Team AI Box trên điện thoại.
- Cài tệp APK của bạn sau khi xác nhận; quyền của ứng dụng Android không được cấp ngầm.
- Cấp ảnh, video hoặc camera trình duyệt cho camera ảo khi được hỗ trợ; camera USB vật lý và nguồn mạng còn yêu cầu quản trị viên thiết lập và cấp quyền.
- Tạm thời cho phép gỡ lỗi ADB trong phạm vi một thiết bị qua bộ chuyển tiếp ngắn hạn, dùng công cụ ADB tiêu chuẩn và ứng dụng chuyển tiếp Node.js.
- Xem tốc độ khung hình, mất gói và thống kê thời gian khứ hồi của kết nối khi cần; những số liệu này không bảo đảm độ trễ đầu cuối.
- Chỉ chọn hồ sơ hệ thống Google Play khi tài nguyên tương ứng có sẵn; khả năng sử dụng không đồng nghĩa với chứng nhận Play Protect hay bảo đảm mọi ứng dụng Android hoạt động.

<a id="feature-computers"></a>

### Máy tính Windows và Linux ảo

- Tạo máy tính Windows/Linux ARM64 độc lập với CPU, bộ nhớ và dung lượng đĩa đã chọn.
- Khởi động máy tính, tắt theo cách thông thường và xóa máy tính đã tắt sau khi xác nhận rõ ràng.
- Mở màn hình ảo trong trình duyệt để xem firmware, quá trình khởi động, cài đặt và giao diện hệ điều hành mà không phải đăng nhập vào máy tính từ xa trước.
- Dùng bàn phím, con trỏ, âm thanh, toàn màn hình và điều khiển kết nối lại.
- Mở cùng một máy tính ảo trong nhiều thẻ hoặc cửa sổ trình duyệt.
- Mời đồng đội xem hoặc điều khiển màn hình và thu hồi quyền truy cập của họ.
- Chuyển quyền điều khiển cho người tham gia khác, nhả quyền hoặc thu hồi với tư cách chủ sở hữu; chọn chế độ một người điều khiển hoặc cùng điều khiển.
- Tải ISO cài đặt lên với các nút tạm dừng/tiếp tục/hủy hoặc chọn ISO có sẵn từ ổ đĩa cá nhân/nhóm.
- Gắn hoặc tháo phương tiện quang ảo và chọn khởi động từ đĩa một lần; thay phương tiện không tự động khởi động lại máy tính.
- Cài hệ điều hành ARM64 mà bạn có quyền sử dụng và dùng riêng tùy chọn máy tính từ xa. Bạn vẫn chịu trách nhiệm về giấy phép Windows; không kèm Windows đã kích hoạt sẵn hoặc hỗ trợ tổng quát cho hệ điều hành khách x86.

<a id="feature-administration"></a>

### Quản trị, phân quyền và bảo mật

- Tạo thành viên cục bộ, quản lý trạng thái tài khoản và đặt lại mật khẩu khi vai trò của bạn cho phép.
- Gán vai trò tích hợp sẵn, xem quyền và quản lý thành viên nhóm với các biện pháp bảo vệ thao tác của chủ sở hữu.
- Lọc sự kiện kiểm toán theo lĩnh vực hoặc mã tương quan, xem chi tiết và yêu cầu kiểm tra tính toàn vẹn của lịch sử kiểm toán.
- Xem trạng thái thiết bị, ứng dụng, bộ nhớ lưu trữ và dịch vụ thực thi trong không gian quản trị.
- Cấu hình nhà cung cấp AI bên ngoài và ánh xạ mô hình/thao tác, luân chuyển thông tin xác thực và bật hoặc tắt nhà cung cấp.
- Đặt chính sách định tuyến cục bộ/bên ngoài được phép, kèm chấp thuận rõ ràng cho xử lý bên ngoài; AI cục bộ không cần API key bên ngoài.
- Xem hồ sơ mô hình đã cài, phiên bản môi trường chạy, mức độ sẵn sàng và chi tiết xác minh.
- Nhập gói plugin đã xác minh và quản lý cài đặt, nâng cấp, bật/tắt và gỡ bỏ các plugin đủ điều kiện; plugin chính thức được bảo vệ có các giới hạn riêng.
- Xem hàng đợi và công việc thực thi, điều chỉnh chính sách lập lịch được phép và hủy công việc đủ điều kiện.
- Xem cài đặt bộ nhớ lưu trữ mã hóa và bảo vệ khởi động. Mở khóa tự động dùng khóa cục bộ; bật cụm mật khẩu khởi động cần xác minh khôi phục và xác nhận.

<a id="feature-installation"></a>

### Cài đặt từ mã nguồn và bảo trì

- Cài đặt từ bản Git clone công khai bằng một lệnh cài từ nguồn đã được hướng dẫn trên DGX Spark mới, tương thích.
- Chuẩn bị công cụ biên dịch, tải mô hình và thành phần môi trường chạy, dựng image ứng dụng, đóng gói và cài đặt trong khi dùng lại môi trường Docker/NVIDIA hiện có.
- Tiếp tục quá trình chuẩn bị bị gián đoạn bằng cùng lệnh và thư mục làm việc, dùng lại các tệp tải xuống đã xác minh và các giai đoạn đã hoàn thành.
- Chạy kiểm tra điều kiện tiên quyết, chỉ chuẩn bị phần tải xuống hoặc chỉ dựng gói cài đặt.
- Chuẩn bị gói hoàn chỉnh có thể chuyển sang máy đích để cài đặt ngoại tuyến; bản thân bước chuẩn bị từ mã nguồn cần truy cập mạng.
- Xác minh các đầu vào đã cố định phiên bản và dùng nguồn thay thế được hướng dẫn hoặc bộ nhớ đệm di động đã xác minh khi cần; không bảo đảm bất kỳ máy chủ mirror bên thứ ba nào.
- Khởi tạo thông tin xác thực mới riêng cho thiết bị và tài khoản admin/admin theo tài liệu, rồi đổi mật khẩu; không sao chép tài khoản hoặc đĩa máy khách từ hộp khác.
- Xem các bản cập nhật bảo trì đề xuất, kết quả tương thích, kế hoạch thực thi rõ ràng và lịch sử kế hoạch với hướng dẫn hoàn tác/khôi phục có phạm vi xác định; không phải tự động nâng cấp tùy ý hệ điều hành hoặc trình điều khiển.

<a id="feature-developers"></a>

### Phát triển mã nguồn mở và phần mở rộng

- Đọc, sửa đổi và phân phối lại mã sản phẩm gốc cùng tài liệu theo MIT; các thành phần bên thứ ba giữ giấy phép riêng.
- Xây dựng phần mở rộng ApplicationPlugin hoặc ComputePlugin bằng đặc tả SDK công khai và các plugin mẫu đi kèm.
- Dùng manifest gói có chữ ký, kiểm tra tính toàn vẹn và quyền khi nhập plugin; điều này không có nghĩa là đã có chợ plugin công khai.
- Đóng góp bản sửa lỗi, bản dịch, tài liệu và tích hợp qua issue và pull request; dùng kênh báo cáo bảo mật riêng cho lỗ hổng.

## NVIDIA DGX Spark là gì?

NVIDIA DGX Spark là hệ thống AI để bàn nhỏ gọn dùng GB10 Grace Blackwell Superchip. Cấu hình 128 GB kết hợp CPU Arm 20 lõi, GPU Blackwell và bộ nhớ hệ thống hợp nhất 128 GB với băng thông 273 GB/s. NVIDIA công bố năng lực tính toán AI lý thuyết tối đa 1 PFLOP ở độ chính xác FP4 có sử dụng tính thưa.

Bộ nhớ hợp nhất là bộ nhớ hệ thống dùng chung, không phải VRAM chuyên dụng. Thông số tùy cấu hình; năng lực lý thuyết không bảo đảm tốc độ ứng dụng hay số người dùng đồng thời.

DGX Spark cung cấp năng lực tính toán. Team AI Box bổ sung giao diện chung cho suy luận cục bộ, tạo ảnh, OCR, chép lời, dịch và cộng tác. Lần cài đầu từ mã nguồn tải các thành phần phụ thuộc và dựng môi trường chạy trước khi thiết lập.

[Thông số phần cứng chính thức của NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box là dự án độc lập của Weerocks LLC, không phải sản phẩm, chứng nhận hay sự bảo trợ của NVIDIA. Phần cứng được hỗ trợ được xác định trong yêu cầu cài đặt bên dưới.

<a id="install"></a>

## Cài trên DGX Spark mới

Cần **DGX Spark chưa cài sản phẩm với Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, trình điều khiển và hỗ trợ container NVIDIA hoạt động, KVM, Git, Python 3.10+. Dành vài trăm GB tạm cho mô hình, bản dựng và gói. Không cài mới đè lên dữ liệu đang có.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Chạy lệnh **trên Spark**. Tập lệnh tải mô hình và đầu vào, dựng image, tạo gói ngoại tuyến đầy đủ rồi cài đặt. Lần dựng đầu cần Internet và thời gian; clone chưa phải cài xong. Docker/NVIDIA được dùng lại.

### Kiểm tra trước và tiếp tục

`--check` kiểm tra điều kiện. Nếu gián đoạn, giữ `/var/tmp/teamaibox-source-build` và chạy lại **cùng lệnh** để dùng lại tải xuống và giai đoạn đã xác minh. Không xóa bộ nhớ đệm hoặc chạy các bản dựng cạnh tranh. Mặc định là nguồn chính thức. Nếu không truy cập được, xem [hướng dẫn](install/SOURCE-INSTALL.vi.md) về nguồn thay thế hoặc chuyển bộ nhớ đệm/gói đã xác minh; mirror không được bảo đảm. Mã thay đổi cần `--work-dir` mới, không bỏ kiểm tra.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Sau khi cài

1. Mở `https://<BOX_LAN_IP>/` bằng địa chỉ LAN hiện tại và xác minh chứng chỉ HTTPS cục bộ thuộc thiết bị của bạn.
2. Đăng nhập `admin` / `admin`, **đổi mật khẩu ban đầu**, rồi tạo tài khoản thường. Không phơi thông tin mặc định ra Internet.
3. Chờ từng ứng dụng sẵn sàng, chọn ngôn ngữ/chủ đề trong hồ sơ.
4. Tự cung cấp ISO ARM64 Windows/Linux và giấy phép hợp lệ. Máy ngoại tuyến cần gói hoàn chỉnh trước, rồi theo [hướng dẫn](install/README.vi.md); chuẩn bị mã nguồn cần mạng.

## Giấy phép và giới hạn

Mã gốc và tài liệu theo MIT, **không phải mọi tệp nhị phân cài đặt**. Bên thứ ba, mô hình, NVIDIA, firmware, Google và Windows giữ điều khoản riêng. Git không có trọng số, đĩa khách đã cài, phiên đăng nhập, ISO hay gói. Tương thích Google không phải chứng nhận Play Protect; trình chiếu không gồm DRM hay chứng nhận Apple. Không tuyên bố hỗ trợ Windows 10 ARM64. Hiệu năng và đồng thời phụ thuộc tải và phần cứng.

<a id="contribute"></a>

## Cùng đóng góp

Chào đón báo lỗi, tài liệu, bản dịch, khả năng tiếp cận, tích hợp và mã. Mô tả vấn đề trong issue, fork và tạo nhánh tập trung, gửi PR kèm kiểm tra và ảnh liên quan. Tài liệu hay thành phần độc lập không cần Spark; ghi rõ xác minh phần cứng thực tế. Không đưa bí mật, tệp cá nhân hay image đã đăng nhập. Báo lỗ hổng riêng theo SECURITY.md. Không bắt buộc CLA hoặc giấy phép đóng góp trả phí.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.vi.md) · [SECURITY](SECURITY.vi.md)

## Tìm hiểu thêm

- [Cài mã nguồn và khôi phục](install/SOURCE-INSTALL.vi.md)
- [Gói ngoại tuyến](install/README.vi.md)
- [Phát triển và dựng mã](docs/open-source/BUILDING.vi.md)
- [Quy trình đóng góp](CONTRIBUTING.vi.md)
- [Báo cáo bảo mật riêng](SECURITY.vi.md)
- [Giấy phép bên thứ ba và phạm vi phát hành](THIRD_PARTY_NOTICES.vi.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Giấy phép bên thứ ba và phạm vi phát hành](docs/open-source/RELEASING.vi.md)
