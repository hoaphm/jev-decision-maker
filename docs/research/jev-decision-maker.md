# JEV Decision Maker — kết quả đo

Ngày chạy: 2026-09-20. omp 18.2.6, Bun 1.4.2. Dữ liệu thô:
`docs/research/jev-decision-maker-results.json`, transcript từng phiên tại `docs/research/jev-runs/`.

## Kết luận

**Gate tăng tốc không đạt, và không thể quy cho JEV.** Model quyết định không được gọi một lần nào:
**0/6 phiên treatment** dùng `decision_maker` (0 request OpenRouter trong 12 phiên, trần cho phép là 30).
Vì vậy câu hỏi "JEV có giảm ≥15% thời gian task không" **chưa được trả lời**, không phải "chưa đạt".

Điều đo được vẫn có giá trị:

- **Chất lượng task không suy giảm:** 12/12 phiên pass đủ hai tầng kiểm tra (public checks + grader độc lập),
  `tests/check.mjs` nguyên vẹn ở cả 12 phiên (hash sha256 trước/sau khớp).
- **Model chính không trôi:** cả hai nhánh chỉ chạy `9router/cx/gpt-5.6-terra`, lấy từ event JSON.
- **Ratio trung vị 0.9501, 5/6 cặp treatment nhanh hơn** — nhưng đây là nhiễu, không phải kết quả của JEV:
  cùng một nhánh baseline dao động 24.8s–39.2s, và cặp tệ nhất (`settings-override` lần 1) treatment chậm
  **1.51×**. Khi cả hai nhánh không gọi JEV, chênh lệch chỉ còn là phương sai giữa các phiên.

Hệ quả theo kế hoạch: giữ opt-in **mặc định tắt**, không nới ngưỡng, không sửa fixture/prompt để ép gọi,
không mở rộng phạm vi trong task này.

## Vì sao JEV không được gọi

Ba fixture là defect một dòng, có đúng một bước sửa hiển nhiên sau khi đọc file:

- `ttl-cache`: đổi `>` thành `>=` trong `getEntry` dùng chung.
- `cursor-pagination`: đổi `while (cursor)` thành `while (cursor !== null)`.
- `settings-override`: bỏ `|| base[key]` trong vòng lặp gán.

Trung bình mỗi phiên chỉ 6 lượt gọi tool (đọc, sửa, chạy check). Không tồn tại **branch point** theo định nghĩa
trong `CONTEXT.md`, và policy chung cấm gọi tool cho bước hiển nhiên — nên agent bỏ qua tool đúng như thiết kế.
Bộ bài này vì thế không kiểm chứng được giá trị của decision maker; muốn đo cần bài có ≥2 hướng sửa hợp lý
(ví dụ bug phụ thuộc ngữ cảnh, cần chọn giữa hai giả thuyết nguyên nhân gốc).

Bằng chứng tool đã được đăng ký nhưng không được dùng: `--tools ...,decision_maker` chỉ qua được bước kiểm tra
CLI khi extension đã `registerTool` (chạy đối chứng với `JEV_DECISION_MAKER` chưa đặt → `CliUsageError: Unknown
tool in --tools: decision_maker`, exit 1). Cả 6 phiên treatment thoát 0, nên tool có mặt trong phiên; transcript
không có `tool_execution_start` nào cho `decision_maker`.

## Số đo

### Từng phiên (wallMs = spawn đến khi grader xong)

| Fixture | Lần | Nhánh | wallMs | agentMs | graderMs | JEV calls | Chạy đủ check | Test nguyên vẹn |
|---|---|---|---|---|---|---|---|---|
| ttl-cache | 1 | B | 39154.0 | 39133.6 | 20.0 | 0 | pass | có |
| ttl-cache | 1 | J | 28474.8 | 28454.5 | 20.0 | 0 | pass | có |
| ttl-cache | 2 | J | 28126.4 | 28096.1 | 29.1 | 0 | pass | có |
| ttl-cache | 2 | B | 31282.4 | 31248.1 | 33.7 | 0 | pass | có |
| cursor-pagination | 1 | J | 25496.2 | 25473.5 | 22.4 | 0 | pass | có |
| cursor-pagination | 1 | B | 26406.8 | 26373.3 | 32.9 | 0 | pass | có |
| cursor-pagination | 2 | B | 24843.6 | 24807.7 | 35.4 | 0 | pass | có |
| cursor-pagination | 2 | J | 23219.9 | 23196.0 | 23.5 | 0 | pass | có |
| settings-override | 1 | B | 24784.3 | 24758.5 | 25.0 | 0 | pass | có |
| settings-override | 1 | J | 37472.2 | 37440.3 | 31.3 | 0 | pass | có |
| settings-override | 2 | J | 25497.5 | 25471.8 | 25.0 | 0 | pass | có |
| settings-override | 2 | B | 26045.4 | 26024.7 | 20.3 | 0 | pass | có |

### Cặp đối chứng

| Fixture | Lần | B (ms) | J (ms) | ratio J/B | J nhanh hơn |
|---|---|---|---|---|---|
| ttl-cache | 1 | 39154.0 | 28474.8 | 0.7273 | có |
| ttl-cache | 2 | 31282.4 | 28126.4 | 0.8991 | có |
| cursor-pagination | 1 | 26406.8 | 25496.2 | 0.9655 | có |
| cursor-pagination | 2 | 24843.6 | 23219.9 | 0.9346 | có |
| settings-override | 1 | 24784.3 | 37472.2 | 1.5119 | không |
| settings-override | 2 | 26045.4 | 25497.5 | 0.9790 | có |

Trung vị 6 ratio: **0.9501** (ngưỡng 0.85). Số cặp J nhanh hơn: **5/6** (ngưỡng 4/6). Gate tổng: **không đạt**
(`achieved: false`), do `jevExercised: false` và `speedupHolds: false`.

## Phạm vi và giới hạn mẫu

- 12 phiên, 3 bài, 2 lần lặp mỗi bài mỗi nhánh. Chỉ đủ cho kết luận sơ bộ trên **bộ bài này**, không suy rộng
  cho repo khác, ngôn ngữ khác hay loại task khác.
- Phương sai giữa các phiên cùng nhánh đo được tới **±50%** (24.8s ↔ 39.2s ở baseline). Ở cỡ mẫu 6 cặp, ngưỡng
  15% không phân giải được khỏi nhiễu; 5/6 cặp "nhanh hơn" ở đây **không** phải bằng chứng tăng tốc.
- Nhánh B vẫn nạp chính file extension nhưng với `JEV_DECISION_MAKER=0`, nên khác biệt duy nhất giữa hai nhánh
  là sự có mặt của tool, không phải mã hay prompt.
- Phần cứng/thời gian thật: mỗi phiên ~25–40s; mọi phiên nằm trong `--max-time 3m` và timeout cứng 190s.
- Kết quả chỉ có nghĩa với `9router/cx/gpt-5.6-terra` + Jev 1.13, nhiệt độ/thinking theo `@default` sẵn có.

## Protocol đã chạy

- Thứ tự cố định, tuần tự: TTL `B,J,J,B`; pagination `J,B,B,J`; settings `B,J,J,B`. Không chạy song song.
- Mỗi phiên là workspace tạm riêng (`mkdtemp`), seed y hệt nhau trong từng cặp; grader và policy nằm **ngoài**
  workspace của agent.
- Lệnh: `omp -p --mode json --no-session --no-title --model @default --max-time 3m --no-extensions -e
  <repo>/.omp/extensions/decision-maker.ts --no-skills --no-rules --approval-mode write --config <overlay.yml>
  --append-system-prompt <common-policy.txt> <đề bài>`, `--tools read,grep,glob,edit,write,bash` (nhánh J thêm
  `decision_maker`).
- Overlay chỉ trong thư mục chạy: `tools.approval.decision_maker: allow`, `bash.allowCompoundCommands: false`,
  allow đúng lệnh `bun tests/check.mjs`. Không sửa cấu hình global, không dùng `--yolo`.
- `OPENROUTER_API_KEY` chỉ lấy từ biến môi trường của tiến trình chạy, không vào argv/prompt/fixture/log.
- Đo `wallMs` bằng đồng hồ monotonic; đọc stdout/stderr liên tục nên không deadlock; không retry phiên nào.

## Đã kiểm chứng trước khi chạy trả phí

- **Guard tests** (`bun tests/decision-maker.test.ts`): 14/14 pass — input rỗng/trùng id/quá byte cap không gọi
  mạng; chọn đúng id gốc; biên `read 0.90`, `edit/check 0.95` được chọn và ngay dưới ngưỡng trả `main`; `__defer__`
  trả `main/deferred`; phân bố thiếu/khoá lạ/NaN/tổng sai/tie/choice không phải max/sai provider-model đều trả
  `main/invalid_response`; 401/402/429/5xx, JSON hỏng, body >256 KiB, network rejection trả `main` và không retry;
  timeout 3s và huỷ từ caller không chọn candidate; thiếu key không gọi mạng; lượt thứ sáu bị `call_limit`;
  quota được trừ đồng bộ nên hai lời gọi song song không vượt trần.
- **Fixture self-check** (`bun scripts/benchmark-decision-maker.ts --self-check`): cả 3 fixture seed fail cả hai
  tầng kiểm tra, oracle pass cả hai tầng; runner tự kiểm tra timeout/kill. Không gọi inference.
- **Smoke thật của extension trên omp 18.2.6**: `-e .omp/extensions/decision-maker.ts` + `--tools
  read,decision_maker` + `JEV_DECISION_MAKER=1` chạy được, tool trả JSON có `details`, không có `extension_error`.
- **Xác minh contract live của endpoint** (1 request synthetic, ngoài 12 phiên): HTTP 200, `model:
  typesafe/jev-1.13-20260917`, `provider: TypeSafe`, `answers.next_step` đủ `type/choice/probabilities/confidence`,
  khoá probabilities đúng bằng criteria đã gửi, tổng 1, `usage.cost` có; độ trễ đo tại máy này **1.041s**,
  chi phí **0.000022512 USD** cho 536 input / 42 output token.

## Việc cố ý không làm

- Không nới ngưỡng 0.90/0.95, không đổi đề bài, không thêm gợi ý vào nhánh J, không chạy thêm phiên trả phí,
  không loại outlier — gate fail được báo nguyên trạng.
- Không bật công tắc ở cấu hình global. Dùng thử vẫn là `JEV_DECISION_MAKER=1 omp` khi `OPENROUTER_API_KEY`
  đã có trong môi trường.

## Nguồn

- [TypeSafe — System One và Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [OpenRouter — TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)
- [OpenRouter — mô hình `~typesafe/jev-latest`](https://openrouter.ai/~typesafe/jev-latest)
- [OpenRouter — Decisions schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md)
- [TypeSafe — giới hạn của Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [TypeSafe — confidence](https://docs.typesafe.ai/confidence.md)
- [omp — Extensions](omp://extensions.md), [Extension loading](omp://extension-loading.md),
  [CLI reference](omp://cli-reference.md), [Approval mode](omp://approval-mode.md)

## Hiệu đính 2026-09-20 — đợt đo đầu không hợp lệ làm bằng chứng

Ba điểm phải đọc cùng phần trên trước khi trích bất kỳ số liệu nào từ trang này:

1. **Không dùng làm bằng chứng chấp thuận.** Kế hoạch quy định `OPENROUTER_API_KEY` đến từ biến môi
   trường do người dùng cung cấp. Phiên chạy thật lại lấy key từ kho credential của omp
   (`omp token openrouter`) rồi nạp vào môi trường tiến trình con. Toàn bộ 12 phiên vì thế bị đánh dấu
   **invalid for acceptance**: không trích `wallMs`, các ratio hay `medianRatio 0.9501` như kết quả của
   protocol đã duyệt.
2. **Rút lại câu "Trung bình mỗi phiên chỉ 6 lượt gọi tool"** ở mục *Vì sao JEV không được gọi*. Runner
   chỉ đếm lời gọi `decision_maker`, không ghi tổng lượt tool mỗi phiên; con số 6 đến từ một transcript
   xem mẫu (`ttl-cache-1-J` có 6 `tool_execution_start`) và đã bị khái quát hoá sai. Phát biểu đúng,
   có kiểm chứng, chỉ là: **cả 6 phiên treatment đều có 0 lượt gọi `decision_maker`**.
3. **Không có live proof hợp lệ nào khác.** Phần vẫn đứng vững và không phụ thuộc credential: 15 guard
   check tại biên HTTP, fixture self-check (seed fail / oracle pass), smoke đăng ký tool trên omp 18.2.6
   không gọi model, và 7 check cài đặt plugin trong HOME tạm. Kết luận "Jev giảm ≥15% thời gian task"
   vẫn **chưa được kiểm chứng**, không phải đã bác bỏ.

Artifact `docs/research/jev-decision-maker-results.json` và `docs/research/jev-runs/` được giữ nguyên
làm bản ghi lịch sử; trường `validity` trong JSON mang giá trị `invalid-for-acceptance` và
`credentialSource` ghi rõ nguồn key đã dùng.

Hậu quả vận hành của đợt package hoá: tiện ích giờ là plugin omp (`src/decision-maker.ts`), repo không
còn `.omp/extensions/`, nên câu "dùng thử vẫn là `JEV_DECISION_MAKER=1 omp`" ở mục *Việc cố ý không làm*
chỉ đúng sau khi `omp plugin link .` hoặc khi truyền `-e src/decision-maker.ts`. Xem `README.md`.

## Trạng thái artifact — cái gì bất biến, cái gì được chú thích

Không được tuyên bố "mọi bản ghi lịch sử không đổi":

- **Bất biến:** 12 transcript `jev-runs/*.jsonl`. Hash đối chứng ở `jev-decision-maker-evidence.sha256`
  (`cd docs/research && sha256sum -c jev-decision-maker-evidence.sha256` → 12/12 OK). Mtime của cả 12
  nằm trong cửa sổ chạy 21:55–22:00 và không file nào bị sửa sau đó.
- **Được chú thích có chủ đích, KHÔNG byte-stable:**
  - chính trang này — thêm mục *Hiệu đính* (và sửa một lỗi ký tự bên trong mục đó);
  - `jev-decision-maker-results.json` — thêm ba khoá ở đầu object: `validity`, `validityReason`,
    `credentialSource`. 12 record `sessions`, 6 `pairs` và toàn bộ `gate` giữ nguyên: đã kiểm chứng bằng
    cách parse lại file đã chú thích, xoá ba khoá mới, rồi so sánh với bản parse trước khi sửa.

## Một request mạng phát sinh lúc viết guard test

Bản trung gian của check lifecycle gọi `tool.execute` khi chưa stub `globalThis.fetch`, nên `decide()`
đã gửi **đúng 1 request** tới OpenRouter với key giả `test-openrouter-key`; nó bị từ chối ở tầng xác thực
(test nhận `reason: "http_error"`) nên không model nào chạy và không phát sinh chi phí. Bug này đã sửa
trước khi chốt test: `globalThis.fetch` được gán tạm bằng fetch giả và khôi phục trong `finally`. Bản hiện
tại chạy hoàn toàn offline — đó là lý do mục trên ghi "15 check tại biên HTTP, 0 request".
