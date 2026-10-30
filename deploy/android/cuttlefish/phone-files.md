# Phone files and APKs

Deployed in the member trial, with real member file/APK checks completed.
Full release acceptance remains incomplete; see the [deployment status](README.md).
The default member phone is AOSP without Google Play/GMS. The separate Google
compatibility test does not change that default. File/APK operations do not
enable an ADB grant. See also the [Chinese quickstart](phone-quickstart.zh-CN.md).

## Member behavior

Open a running phone, then **More → Files and APKs**. Select a non-empty file
up to 256 MiB. **Send file** writes only to `Download/TeamAIBox` inside that phone.
**Install APK** asks for confirmation and reports Android's actual result; it
does not automatically grant permissions. Names stay readable, while paths and
temporary directories are chosen by the server. Existing guest files are not
silently overwritten. The file list supports owner-authorized download.

Cancel interrupts the transfer and discards unfinished staging. If Android
already committed an installation, cancellation cannot uninstall it; the UI
explicitly asks the user to check the phone. Closing the dialog or changing the
phone/run aborts the old request. It never stops another phone or Android itself.

## Implementation boundaries

1. Existing `/api/v1/objects/multipart` accepts `virtual_phone`, still requiring
   current identity, Origin/CSRF and file permissions. Parts go into the owner's
   existing encrypted object namespace; incomplete uploads are aborted. Completed
   input objects remain owned objects, not untracked plaintext temporary files.
2. Typed phone APIs accept object identity/version, expected generation, name,
   length and SHA-256. The service rechecks current login/permission/owner/run;
   logout or run replacement aborts an active transfer. One transfer per phone,
   at most two per node/service instance, with a 120-second worker deadline.
3. Existing Node Agent mTLS/HMAC transport streams bytes over `/v1/phone-files`.
   Signed metadata binds the target node generation, phone, run and one-time
   operation. It cannot specify Docker arguments, a host path, or a command.
4. The non-root worker invokes a fixed internal Android file/install operation.
   Its exact-byte framing, SHA-256, per-operation staging and pinned guest file
   descriptor reject truncated content, traversal and symlink escape. Staging
   is under the phone's encrypted data volume and removed in `finally`.
5. Exports are stored using existing AES-256-GCM objects, then downloaded via
   a short-lived owner-scoped reference. Browser code checks length/checksum
   before offering a local download. No payload, filenames from real users,
   credentials, or screen content belongs in qualification logs.

The existing object service decrypts an input object into a bounded in-memory
buffer before handing out 64 KiB chunks; it is not described as zero-copy.
Node transfer and output storage are streamed with bounded chunks. The 256 MiB
cap and concurrency limit bound peak transient memory. The borrowed decrypted
input is wiped after consumption.

## Implementation and verification

Downloads inspect the opening shell descriptor through `/proc/$$/fd/3`.
APK installation uses `cmd package install -r -S SIZE -- -`, without `-g`.

The synthetic transfer-app sources live under `tools/fixtures/phone-transfer-app/`.
No prebuilt APK or historical member-transfer report is included. Build the
fixture using `tools/build_phone_transfer_fixture.py` with an installed SDK;
the helper uses an ephemeral test signing key. Each generated APK needs its
own source-bound qualification and must never include an account or user data.

Source checks:

```sh
python3 -m unittest tools/test_cuttlefish_phone_files.py tests/test_cuttlefish_runtime_validator.py
node --test apps/platform-api/test/virtual-phone-file-service.test.mjs apps/platform-api/test/virtual-phone-file-transport.test.mjs apps/platform-api/test/virtual-phone-object-transfer.test.mjs apps/platform-api/test/virtual-phone-http-api.test.mjs apps/platform-api/test/object-http-api.test.mjs
TEAMAIBOX_TEST_PHONE_POSTGRES=1 node --test apps/platform-api/test/virtual-phone-postgres.test.mjs
TEAMAIBOX_PHONE_UI_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs node --test apps/virtual-phones-plugin/test/*.test.mjs
```

Runtime and driver qualification alone do not establish an HTTPS member
workflow or browser-media acceptance. Verify the changed path on an explicitly
authorized installation and keep its private evidence outside public sources.
