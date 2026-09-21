# JEV: ledger các lần chạy batch phán đoán

Mỗi lần thử đều là tiền thật. Ghi đủ, kể cả lần hỏng, kể cả khi lỗi thuộc về harness.

Số "request đã tiêu" dưới đây là **request HTTP thật đã gửi**, đọc từ `smoke.json` của từng run dir — không phải con số reconcile trong `gate.jevRequests`, vốn đếm số call đã *dự kiến* bất kể chúng có gửi đi hay không.

| Run dir | Batch | Kết quả | Request thật đã gửi | Phiên model chính |
|---|---|---|---|---|
| `run-3Q906w` | judgment (aborted) | Smoke: select gửi 1 request và `selected`; score **không gửi request nào** (`main`/`invalid_input`) vì `brief.json` của fixture score thiếu `rubric`. Harness báo sai thêm một lần nữa vì đọc ack `prompt`/`prompt_result` sai thứ tự frame | **1** | 0 |
| `run-GUwD9b` | judgment (aborted) | **Cùng hai defect**: score vẫn `invalid_input` 0 request (rubric vẫn thiếu — lần sửa trước chỉ sửa thứ tự chờ frame), rồi vẫn chết ở check ack | **1** | 0 |
| `run-TLHblq` | judgment (collected) | Protocol đóng băng, smoke pass (select 1 + score 1), 12/12 phiên, 1 call score trong phiên, 12/12 winner đúng ở cả hai arm | **3** | 12 |

Tổng request JEV thật: **5** (1 + 1 + 3); con số reconcile tương ứng là 7 và chênh nhau đúng ở chỗ hai lần abort không hề gửi request score nào. Chi phí model chính đo được của lần thu thập: **0,3416 USD** cho 12 phiên.

## Bài học tách bạch

1. **Cả hai lần abort (harness driver)**: frame ack trong omp 18.2.7 có thể tới **sau** notify dưới dạng `prompt_result` riêng, không nằm trong `response.data`. Sửa: chờ **cả** hai frame, nhận cả hai hình dạng ack.
2. **Cả hai lần abort (fixture defect)**: prompt của fixture score nói "the supplied ordered rubric" nhưng `brief.json` không mang rubric, nên agent (và smoke) không có rubric để truyền → `prepare()` trả `invalid_input`, và **0 request** được gửi. Sửa: đưa rubric vào `brief.json` — đây là **tuân thủ spec đã đóng băng** (plan ghi rõ fixture B có `rubric` là dữ liệu bài, không phải oracle), không phải tinh chỉnh sau khi xem kết quả: cả hai lần hỏng đều dừng ở smoke, **chưa phiên model chính nào chạy**, nên chưa có kết quả nào để nhìn.
3. **Giá trị của cổng smoke**: cả hai defect đều bị bắt bởi smoke 2 request (~0,00013 USD) thay vì bởi 12 phiên model chính (~0,34 USD). Giữ cổng này.

## Bằng chứng

`docs/research/jev-effective-runs/` giữ bản sao bền của cả ba run dir (`results.json`, `report.md`, `smoke.json`, `smoke.frames.jsonl`, transcript từng phiên, `manifest.json`) cùng `harness.ts` đã dùng và `hashes.sha256`. Không file nào chứa giá trị credential (kiểm bằng membership với cả key OpenRouter lẫn key 9router của máy này).

## Lần chạy Stage 1 của protocol v2 (đã tiêu tiền)

| Run dir | Stage | Request gửi | Kết quả | Phán quyết đã đóng băng |
|---|---|---|---|---|
| `docs/research/jev-effective-protocol-2/runs/run-TJnels` | Stage 1 | **70** (69 có cost, 1 cost null) | hạng mục **11/30**; select 12/30 commit và **12/12 đúng**; score 27/30 đúng, 29/30 commit, 0 hoà; 1 `invalid_response`; 1 đảo thứ tự | **dừng — không chi Stage 2** (luật ≤ 19/30) |

- Chi phí thật: **0,002597 USD**; 38,7 giây tường; latency median select 498 ms, score 470 ms, permuted 499 ms; mỗi call đúng **một** HTTP request.
- Không chạy Stage 2: tiết kiệm ~0,55 USD đúng theo luật đã đóng băng. Kết luận không phụ thuộc call lỗi duy nhất (kể cả call đó đúng thì cũng chỉ 12/30 ≤ 19/30), nên **không** chạy lại Stage 1 dù §4.1 cho phép khi `clientFailures > 0`.
- Diễn giải tách lớp: model **không** chọn sai trong mode `select` — 12 lần nó quyết định thì đúng cả 12, còn 18 lần cổng 0.90 từ chối (`uncertain`). Sai thật nằm ở `score`: 2/29 call commit là sai (F4, F10). Vì vậy phán quyết "dừng" ở trên là hệ quả của định nghĩa *hạng mục* (đòi cả hai view đúng), không phải của chất lượng phán đoán.
- **Lỗ hổng thiết bị đo (phải ghi, không được lấp liếm):** `Stage1Call` của v2 **không** ghi `probability`/`probabilities`, nên không thể trả lời câu hỏi "hạ ngưỡng 0.90 xuống mức nào thì vừa nhận thêm call đúng mà không nhận call sai" từ dữ liệu này — dù sản phẩm **có** trả hai trường đó cho call bị từ chối. Không được chạy lại Stage 1 để bổ sung một phân tích hậu nghiệm (§4.1 chỉ cho phép chạy lại vì lý do sức khoẻ endpoint). Việc này thuộc protocol v3, phải đóng băng trường đó trước khi chạy.
- Ngưỡng 0.90/0.95 **không** bị đổi trong batch này; không có tham số nào được tinh chỉnh sau khi xem kết quả.

### Sửa runner sau khi chạy (chỉ hiển thị + ghi ngưỡng, có kiểm chứng)

Ba thay đổi, tất cả **sau** lần chạy `run-TJnels`, không đổi số đo và không đổi phán quyết:

1. **Thanh dừng in sai một đơn vị**: `report.md` in `≤ 18/30` còn `METRIC_RULES`/`protocol.md` đóng băng `≤ 19/30` (code dùng `floor(forks*0.633)`). Sửa thành `Math.round(forks*19/30)`.
2. **Danh sách call lỗi bị gán sai lớp**: một mảng `failedCalls` dùng chung, nên báo cáo liệt kê `F3:score:invalid_response` (lỗi client) ngay sau nhãn "authoring". Tách thành `clientFailureCalls` / `authoringCalls` tại nguồn; verdict in đúng danh sách theo từng nhánh.
3. **Render trở thành chỉ-đọc**: bản render lại từng in ngưỡng *tính lại* bằng hằng số mới bên cạnh note ngưỡng *đã lưu* của lần chạy —— hai thanh dừng khác nhau trong cùng một báo cáo. Từ nay lần chạy **lưu `stage1.thresholds`** (kèm hash runner đã tính chúng) và `renderReport` chỉ in lại con số đã lưu; artifact cũ thiếu trường đó thì in note gốc kèm một dòng giải thích, **không** tính lại.

Bằng chứng không đổi số: `--render` sang file **mới** `runs/run-TJnels/report-final.md`, `results.json` giữ nguyên hash `22cb1aa19e36…`, và **mọi hàng bảng của `report.md` và `report-final.md` giống hệt nhau** (diff sạch). Phán quyết không đổi: 11 ≤ 18 < 19 nên cả hai cách tính đều dẫn tới "dừng".

Hash runner sau khi sửa: `815b073032596c0f880bfe92faef9b96aeff329ef5e3ea8efa3c6df82c0a3ba4` (thay đổi chỉ ở phần in và ở ghi ngưỡng; `--v3` được thêm **sau** đó, hash tại thời điểm chạy v3 nằm trong `freeze.json` của chính run v3). `freeze.json` của lần chạy vẫn ghi hash **trước** khi sửa (`85bba380ddd1…`) — đó là logic đã thực thi. Chi tiết và thẩm quyền của từng file: `runs/run-TJnels/report-errata.md`.

## Lần chạy protocol v3 (ngưỡng `select`) — cả hai đều VÔ HIỆU vì endpoint

| Run dir | Request | Kết quả | Vì sao vô hiệu |
|---|---|---|---|
| `docs/research/jev-effective-protocol-3/runs/run-lRkkWj` | 120 | 45 `http_error`, 4 `timeout`, 1 `invalid_response`, 70 dùng được | `clientFailures` 50 > trần 3 |
| `docs/research/jev-effective-protocol-3/runs/run-wgNHFd` (chạy lại vì sức khoẻ endpoint, có bắt status) | 120 | HTTP **200:47, 400:5, 503:14, 529:3, không phản hồi:51** | `clientFailures` 75 > trần 3 |

- Chi phí thật của cả hai: **0,002105 + 0,001326 = 0,003431 USD** (call lỗi không tính cost).
- Không có header rate-limit hay `retry-after` trong cả hai lần ⇒ không phải quota của mình.
- **Không áp dụng ngưỡng nào.** Luật đã đóng băng (§4/§6 của `jev-effective-protocol-3/protocol.md`) nói rõ: `clientFailures > 3` ⇒ batch vô hiệu, giữ nguyên ngưỡng, không sửa dòng code nào. Con số "read/edit/check → 0.5" mà runner in ra là hệ quả của một mẫu hỏng (chỉ 35/90 điểm select dùng được ở lần hai) nên **bị vô hiệu theo**, không phải một quyết định.
- Quyền chạy lại vì sức khoẻ endpoint đã dùng **một lần** và kết quả tệ hơn (50 → 75 lỗi), nên dừng: không chi thêm cho tới khi endpoint lành.
- Lần đo **hợp lệ gần nhất** vẫn là v2 Stage 1 (`runs/run-TJnels`): 12/12 call `select` đã ra quyết định thì đúng, 18/30 bị cổng 0.90 từ chối, `score` 27/30. Câu hỏi "hạ ngưỡng xuống đâu" **vẫn mở**.
- Ghi nhận một lỗ hổng quan sát của sản phẩm: `http_error` gộp cả 400 (phía ta) lẫn 503/529 (phía họ), và response body bị huỷ nên không đọc được thông điệp lỗi — 5 call 400 rải rác ở F21/F25/F26/F30 không thể chẩn đoán thêm từ artifact. Nếu cần, đó là việc của protocol sau.
- Hash dùng cho v3: `protocol.md` `cffdd0511f69e08a3f5130de7e873c50af94231923d416e5940abd0cf3f9fb1d`, runner `813c0275993f8f8d5b649d8e2d8d02507d7128592900197c0ee1433c501b437d`.

### v3.1 — siết luật sau hai lần v3 vô hiệu

- Không có phán quyết v3 nào được áp dụng (cả hai lần vô hiệu vì endpoint), nên việc siết luật **không** phải tinh chỉnh hậu nghiệm. Bốn siết: τ phải > sàn lưới; hold-out phải có `committed ≥ 5` **và** `correct ≥ 5`; so sánh recall từ mốc 0 là vô nghĩa nên bị từ chối; và chỉ in phán quyết khi coverage đúng kế hoạch (train 20/kind, hold-out 10/kind).
- Health pre-flight 10 call trong chính batch (HTTP ≥ 500 hoặc không phản hồi ⇒ dừng, không gửi 110 call còn lại) + fail-fast 5 lỗi liên tiếp; plan đổi sang **repeat-major** để một cửa sổ outage làm mỏng mọi kind theo cùng tỉ lệ thay vì xoá trắng hold-out của một kind.
- `protocol.md` của v3 (đã gồm §9 v3.1): `74e71caede08173fa69539c674058c1d445d99eaba861f16c215e4159506f5a8`. Runner: `815b073032596c0f880bfe92faef9b96aeff329ef5e3ea8efa3c6df82c0a3ba4`.
- `report-fixed.md` (bản render trung gian còn mang mâu thuẫn thanh dừng) đã bị xoá; `report-errata.md` ghi lại việc xoá đó, `report-final.md` là bản có thẩm quyền.

## Lần chạy v3 thứ ba (có health gate) — endpoint lành, batch vẫn vô hiệu vì hợp đồng response

| Run dir | Request | HTTP | Kết quả | Vì sao vô hiệu |
|---|---|---|---|---|
| `docs/research/jev-effective-protocol-3/runs/run-mNCTlD` | 120/120 (không dừng sớm) | **toàn bộ 200** | 37 `selected`, 25 `scored`, 51 `uncertain`, 1 `deferred`, **6 `invalid_response`** | `clientFailures` 6 > trần 3 |

- Health gate 10 call đầu **không** kích hoạt (đúng: không có 5xx, không timeout) ⇒ endpoint lần này khoẻ, khác hai lần trước (50 và 75 lỗi, toàn 503/529/timeout).
- 6 lỗi đều là `invalid_response` (response sai hợp đồng), **5/6 ở mode `score`**: index 21 read/select, 95 check/score, 99 read/score, 103 edit/score, 104 check/score, 113 check/score. Cộng dồn ba lần chạy: ~10 `invalid_response` trên ~380 call, tập trung ở `score`.
- Sweep (chỉ để chẩn đoán, **không** được áp dụng): `read` **không có phán quyết** vì coverage 19/20 (một call chết ở index 21), `edit` 0.95→0.51, `check` 0.95→0.51. Đường cong cho thấy cổng hiện tại đang bóp nghẹt cả ba kind: `read` commit 6/15 call đúng (recall 0.40), `edit` 2/18 (recall 0.11), `check` 16/20 (recall 0.80) — và ở τ=0.51 precision trên hold-out vẫn 1.0 cho cả ba.
- **Không áp dụng gì.** Luật đã đóng băng nói `clientFailures > 3` ⇒ vô hiệu, và τ=0.51 chỉ cách sàn lưới một bước — dấu hiệu lưới quá thô ở vùng thấp, không phải một kết quả đo. Ngưỡng sản phẩm giữ nguyên `read 0.9 / edit 0.95 / check 0.95`.
- Chi phí lần này: **0,003391 USD** (114/120 call có cost).
- Hash runner đã dùng: `815b073032596c0f880bfe92faef9b96aeff329ef5e3ea8efa3c6df82c0a3ba4`. Giả thuyết đáng kiểm bằng protocol sau (chưa được chứng minh bởi lần chạy này): lưới mịn hơn ở 0.40–0.60, hold-out dày hơn, và **giữ lại body của response khi `invalid_response`** (wrapper có thể clone trước khi sản phẩm đọc) để phân biệt "endpoint trả sai dạng" với "validator của ta quá chặt" — hiện tại không phân biệt được, và chính nó là thứ giữ batch ở trạng thái vô hiệu.

### v4 — chẩn đoán `invalid_response` trước, rồi mới tới ngưỡng

- Freeze: `protocol.md` của v4 `12b9244409acf10d0c2738d8e67ea28b0ddd4cb4aa632120ce3f7bf330a24572`; runner `bb2e6183ecbf2dbfbc6072b864840ba152ed4f1f2edc5e6ab2c73280de81c718` (thêm `--v4`, `responseBody`, health gate mở rộng sang **mọi non-2xx** với nhãn `health` vs `rejected`, grid 0.40–0.99, train r1–r3 / hold-out r4–r5, volume hold-out ≥ 8).
- Kế hoạch 180 call (30 fork × 5 repeat select + 30 score), ~0,007 USD, 0 phiên model chính.
- Thứ tự đọc kết quả đã đóng băng: chẩn đoán body trước, phán quyết ngưỡng sau, và ngưỡng chỉ được sửa khi batch hợp lệ **và** sweep chấp nhận.

## Lần chạy v4 (hợp lệ đầu tiên) — chẩn đoán + áp ngưỡng

| Run dir | Request | HTTP | clientFailures | Kết quả |
|---|---|---|---|---|
| `docs/research/jev-effective-protocol-4/runs/run-eKjtHU` | 180/180 | toàn bộ 200 | **1** (≤ trần 3) | batch **hợp lệ**; sweep chấp nhận `edit` 0.95→0.41 và `check` 0.95→0.41; `read` không phán quyết (hold-out 7 < sàn 8) |

- Chi phí: **0,005090 USD**; 115 giây; 0 phiên model chính; health gate không kích hoạt (endpoint lành).
- **Chẩn đoán (1) — câu hỏi đã trả lời:** body của call `invalid_response` (F12/score/r1) là response **hợp lệ**: có `provider`, đủ 4 câu trả lời đúng khoá, `legend` khớp rubric, `confidence` trong [0,1], kỳ vọng lệch ≤ 0,03. Sai duy nhất: tổng xác suất của `score_no-error` = **0,99**. Vậy **validator của client quá chặt**, không phải endpoint trả sai dạng: nó so tổng với 0,001 trong khi endpoint làm tròn từng giá trị 2 chữ số thập phân (sai số tối đa 0,005×n).
- **Sửa kèm:** band tổng đổi từ 0,001 thành `0,005 × n` (suy từ bước làm tròn), có test pin: tổng 0,99 và 1,01 trên 4 giá trị được nhận, 0,95 bị từ chối.
- **Áp ngưỡng theo luật đã đóng băng:** `PROBABILITY_THRESHOLDS` = `read 0.9`, `edit 0.41`, `check 0.41`; ADR `docs/adr/0002-measured-probability-thresholds.md`; test biên giờ suy từ chính hằng số đó; README Bounds cập nhật.
- **Cảnh báo kèm theo:** thứ tự ngưỡng hiện **ngược với rủi ro** (`edit` sửa file lại lỏng hơn `read`), và 0,41 chỉ cách sàn lưới 0,40 một bước — dấu hiệu lưới vẫn là ràng buộc, nên bước tiếp theo nên quyết gate theo **`confidence`** (trục TypeSafe tài liệu hoá cho đúng việc này) chứ không theo xác suất chọn thô.
- Hash runner tại thời điểm v4: `f351deb26b8cd81aaaf7d00660ccebce5a98417b002ca4a044932434d5cde82a` (thêm `--v4`, `responseBody`, health gate phân biệt `health`/`rejected` và **chỉ tính call đã thực sự gửi** — call không gửi được như `missing_key`/`call_limit` không còn bị dán nhãn "provider outage").

## Lần chạy v5 — sáu repeat + probability song song confidence

| Run dir | Request | Kết quả |
|---|---:|---|
| `docs/research/jev-effective-protocol-5/runs/run-bw2X7Q` | 210 | **hợp lệ**: HTTP 200, clientFailures 0, authoringErrors 0, 210/210 call; kết quả đầu, trước khi report-label fix |
| `docs/research/jev-effective-protocol-5/runs/run-j4hgUL` | 210 | **hợp lệ**: HTTP 200, clientFailures 0, authoringErrors 0, 210/210 call, 0 invalid body; rerun để sửa report/freeze labeling, không phải endpoint health |

- Chi phí v5 cộng dồn: **0,011760 USD** (0,005880 + 0,005880), 2 × 210 request, không phiên model chính. Lần rerun thứ hai **vi phạm quy tắc §4.1** của protocol v5 (rerun chỉ được phép vì endpoint health): nó được chạy để sửa wording/freeze label, không được dùng để chọn kết quả tốt hơn. Giữ cả hai `results.json`; không gộp số giữa hai run.
- Cả hai run đều không đổi code threshold. Không run nào có invalid body; không có threshold nào được áp.
- Probability sweep: run-j4hgUL `read` giữ 0,90 vì hold-out chỉ commit/correct 6 (< volume floor 8); `edit` giữ 0,41 vì hold-out recall 1 không cao hơn current 1; `check` giữ 0,41 vì hold-out recall 1 không cao hơn current 1.
- Confidence sweep chạy song song: `read` 0,79 (không đủ hold-out volume), `edit` 0,27 (recall không cao hơn current descriptive 0,5→1), `check` 0,21 (recall không cao hơn current 1); **không axis confidence nào là product verdict**.
- Run-bw2X7Q là lần đầu; run-j4hgUL là artifact có freeze/protocol label đúng. Khi cần trích số, dùng run-j4hgUL nhưng không che việc đã tiêu tiền lần đầu.
- Hash runner tại thời điểm ledger cập nhật: `aee980a00e9b52c1397834d4c922e626fac2cefd6203c7f6aa6457bc2aa7a284`; hash protocol v5: `6bb98958380198cb4eec39e5df4c64c4d22aa298bb982b9bb666998058781622`.

## Freeze của protocol v2

Hash lấy **sau** khi sửa hết các lỗi (đơn vị ngưỡng commit = call, `20/70`; trần client failure `> 3` cho cả hai stage; `invalid_input` tách thành lỗi authoring; pre-flight arm E đóng băng; assert label thật thay cho check không thể fail) và **trước request trả phí đầu tiên**.

- `protocol.md` — `7d6568dd67d9eeb49806a414d47a1197a0fc6930a077d3144e2823ebdbdc55ed`
- `cases.json` (10 dossier × 3 fork; mọi `contract` nằm nguyên văn trong `state`; cap của sản phẩm được validate trước khi chạy) — `682b14d5193ec2a9f8a72289f43d6204aba0a0ec185a84eb591124a07d637036`
- `runner.ts` (`--self-check` xanh offline: 30 fork hợp lệ, seed/oracle/non-winner cho hai dossier, schema + description + description-parity của tool thật và tool rỗng, assert label `JEV on`/`JEV off` từ probe thật, parser tách `control`/`invalid_input`, 14 nhóm hash) — `85bba380ddd14b4f4d9cdf032116275b32de1edba2d9ca9ab24ffe44c44e2d4b`
- `stub-extension.ts` (tool rỗng, `reason: "control"`, không mạng, không quota, không status line) — `bd028ad301e5cffc808b7d5f1289fb8732d839889c8ce94004e5639bf6699235`

Đổi bất kỳ fixture, prompt, rubric, policy, arm, thứ tự, ngưỡng hay định nghĩa metric nào ⇒ protocol mới, số liệu cũ không được gộp. Runner tự ghi thêm `freeze.json` (14 nhóm hash, gồm cả `metricRules`) ngay trước request trả phí đầu tiên của mỗi stage.
