<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.th.md)
<!-- doc-navigation:end -->

# Team AI Box แพ็คเกจการติดตั้งออฟไลน์

ใบอนุญาตสำหรับรหัสต้นฉบับอยู่ในชุด `LICENSE` ส่วนประกอบของบุคคลที่สามยังคงลิขสิทธิ์ดั้งเดิมไว้ ดูที่ `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json` MIT ไม่ให้สิทธิ์ในการแจกจ่ายซ้ำเพิ่มเติมสำหรับบริการของ Google, Windows, น้ำหนักโมเดล หรือแบรนด์บุคคลที่สาม การผ่านการตรวจสอบความสมบูรณ์ของแพ็คเกจไม่ได้กำหนดสิทธิ์ในการแจกจ่ายซ้ำสำหรับทุกส่วนประกอบ

แพ็คเกจนี้มีไว้สำหรับ DGX Spark ใหม่ซึ่งยังคงใช้ระบบ Linux จากโรงงานที่เข้ากันได้ ใช้สภาพแวดล้อม Docker, Compose และ NVIDIA GPU ที่มีอยู่โดยไม่ต้องแทนที่หรือฟอร์แมตดิสก์ระบบ

## การติดตั้ง

ตรวจสอบไฟล์เก็บถาวรโดยใช้ไฟล์ `.sha256` ที่แนบมา จากนั้นแตกไฟล์:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

การติดตั้งปกติไม่จำเป็นต้องเข้าถึงอินเทอร์เน็ตสาธารณะหรือแก้ไขตัวแปรสภาพแวดล้อมด้วยตนเอง โปรแกรมติดตั้งจะจัดหาเครื่องมือแบบบันเดิลที่จำเป็น สร้างการกำหนดค่าภายในเครื่องที่เป็นอิสระ เริ่มต้นฐานข้อมูลใหม่ และเริ่มบริการ การโหลดโมเดลเริ่มต้นอาจต้องใช้เวลา ไฟแสดงการโหลดไม่ใช่การยืนยันการติดตั้งสำเร็จ

เรียกใช้ `sudo ./install.sh --check` เพื่อตรวจสอบสภาพแวดล้อมและแพ็กเกจโดยไม่ต้องติดตั้ง `./install.sh --verify-package` ตรวจสอบเนื้อหาแพ็คเกจเท่านั้น และยังสามารถรันบนเวิร์กสเตชันการทำบรรจุภัณฑ์ได้อีกด้วย ใช้ `--installation-root /dedicated/path/installation` เพื่อระบุรูทการติดตั้งใหม่ อย่าชี้ไปที่ข้อมูลที่มีอยู่

## การหยุดชะงักและข้อมูลที่มีอยู่

หลังจากเกิดความล้มเหลวหรือการขัดจังหวะ ให้แก้ไขปัญหาที่รายงานแล้วทำซ้ำคำสั่งเดิม อย่าลบไดเร็กทอรีการติดตั้ง โปรแกรมติดตั้งจะรักษาข้อมูลประจำตัวและข้อมูลที่สร้างขึ้น การเรียกใช้การติดตั้งเวอร์ชันเดียวกันที่สมบูรณ์อีกครั้งจะตรวจสอบสถานะเท่านั้น เวอร์ชันอื่นๆ ใช้เส้นทางการอัพเกรดอย่างเป็นทางการ ไม่ใช่การลบออกและการติดตั้งใหม่ ไม่มีตัวเลือกการบังคับเขียนทับ

## ใช้ครั้งแรก

เปิดที่อยู่ HTTPS ที่ IP ปัจจุบันของอุปกรณ์แล้วลงชื่อเข้าใช้:

- ชื่อผู้ใช้ของผู้ดูแลระบบ: `admin`
- รหัสผ่านเริ่มต้น: `admin`

โปรแกรมติดตั้งจะสร้างผู้ดูแลระบบนี้โดยอัตโนมัติ ไม่จำเป็นต้องแยกโทเค็นการตั้งค่าหรือการลงทะเบียนด้วยตนเอง รหัสผ่านเริ่มต้นเป็นแบบสาธารณะและเรียบง่าย: เปลี่ยนรหัสผ่านในการจัดการผู้ใช้ก่อนส่งมอบ/ใช้งาน ผู้ใช้ทั่วไปไม่มีบัญชีเริ่มต้นและถูกสร้างขึ้นโดยผู้ดูแลระบบ สิ่งนี้ใช้ได้กับฐานข้อมูลบัญชีที่ว่างเปล่าเท่านั้น ดำเนินการต่อ รันใหม่ รีบูตและอัปเกรด ไม่เคยรีเซ็ตบัญชีหรือรหัสผ่านที่มีอยู่เป็นค่าเริ่มต้น รหัสกู้คืนของผู้ดูแลระบบที่สร้างขึ้นโดยอิสระจะถูกเก็บไว้ภายใต้รูทการติดตั้งที่ `secrets/initial-owner-recovery.json` ซึ่งอ่านได้โดยรูทเท่านั้น อย่าส่งรหัสกู้คืนไปที่แชท ตั๋ว หรือบันทึกสาธารณะ การติดตั้งที่มีอยู่ไม่ได้สร้างหรือแทนที่รหัสกู้คืน สำหรับใบรับรอง HTTPS ที่ออกในเครื่อง ให้กำหนดค่าความน่าเชื่อถือของเบราว์เซอร์ตามคำแนะนำของ CA ของผู้ดูแลระบบ ชื่อในใบรับรองไม่รับประกันความละเอียดของ LAN DNS/mDNS โดยปกติใบรับรองสาธารณะของ CA ในเครื่องจะอยู่ที่ `/srv/teamaibox/installation/https/ca.crt` แจกจ่ายเฉพาะใบรับรองสาธารณะนั้น ห้ามเผยแพร่คีย์ส่วนตัวข้างๆ

การติดตั้งไม่รวมเครื่องเสมือนที่มีอยู่ สถานะการเข้าสู่ระบบ Google หรือไฟล์ผู้ใช้ ผู้ใช้อัปโหลด ISO ของ Windows/Linux หรือเลือกจากไดรฟ์ของทีม จากนั้นจึงติดตั้งระบบเกสต์ด้วยตนเอง Google Play และ API ภายนอกจำเป็นต้องมีการเข้าถึงอินเทอร์เน็ต และไม่รวมอยู่ในสัญญาความพร้อมใช้งานแบบออฟไลน์

ข้อความสิทธิ์การใช้งานส่วนประกอบจะถูกเก็บรักษาไว้พร้อมกับทรัพยากรที่เผยแพร่ ลิขสิทธิ์© Weerocks LLC ติดต่อ: teamaibox@weerocks.llc
