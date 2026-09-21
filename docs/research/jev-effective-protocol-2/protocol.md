# Protocol v2 — đo phán đoán của JEV, có arm đối chứng

Trạng thái: **đóng băng trước lần chạy trả phí đầu tiên**. Sau request trả phí đầu tiên, mọi sửa đổi fixture, prompt, rubric, policy, arm, thứ tự, ngưỡng, định nghĩa metric hay cách phân loại reason đều **không hợp lệ**: phải mở protocol mới với id mới. Không có ngoại lệ "chỉ sửa nhỏ".

Thi công kèm theo (đã self-check offline, chưa chạy):

| File | Vai trò |
|---|---|
| `docs/research/jev-effective-protocol-2/cases.json` | 10 dossier × 3 ngã rẽ = 30 fork, mỗi fork có `contract` nằm nguyên văn trong `state` và oracle suy được từ câu đó |
| `docs/research/jev-effective-protocol-2/runner.ts` | `--self-check` (offline) / `--stage1` / `--stage2` / `--render` |
| `docs/research/jev-effective-protocol-2/stub-extension.ts` | Tool rỗng của arm E: cùng tên, cùng description, cùng schema, trả `main`/`control`, không mạng |
| `src/decision-maker.ts:TOOL_DESCRIPTION` | Được export để arm E dùng **nguyên văn** description của tool thật |

Protocol v1 (`docs/research/jev-decision-maker.md`) và batch v2 đầu (`docs/research/jev-effective-runs/attempts.md`) là lịch sử; số liệu của chúng không gộp vào đây.

## 1. Vì sao cần protocol mới

| Vấn đề đo được ở batch trước | Bằng chứng | Cách sửa trong v2 |
|---|---|---|
| Không đủ mẫu để nói gì về chất lượng phán đoán | 12 phiên, chỉ **1** call JEV | Stage 1: **70 call trực tiếp**, không agent |
| Bài dễ: main model tự giải đúng 12/12 | 6/6 winner mỗi arm | 30 ngã rẽ, oracle theo câu contract nằm trong brief, không theo "sửa một dòng" |
| Không tách được chi phí bị bắt gọi khỏi giá trị phán đoán | Chính batch v1 ghi đây là thiếu | Arm E: tool rỗng cùng schema |
| Policy phát kèm chưa từng tới model | Phiên chạy `--no-rules` | Arm J và E **append nguyên văn `rules/decision-maker.md`** |
| Ngưỡng 0.90/0.95 chưa từng được một call trong phiên chạm tới | 1 call, `score` mode (không qua ngưỡng) | Stage 1 đo cả `select` để biết ngưỡng cắt mất bao nhiêu |

## 2. Stage 1 — đo phán đoán trực tiếp (không agent)

Runner gọi `decide()` trực tiếp qua resolver OMP, không qua agent, không tốn token model chính. Nó dùng budget riêng bằng số call: **đây là bypass có chủ ý** quy ước 5-call/phiên của plugin, vì Stage 1 đo model chứ không đo policy phiên — và được ghi rõ trong `results.json`.

### 2.1 Ba mươi ngã rẽ

`cases.json` có 10 dossier, mỗi dossier 3 ngã rẽ (một `read`, một `edit`, một `check`):

`cache-isolation`, `retry-amplification`, `cursor-pagination`, `migration-idempotence`, `auth-precedence`, `ratelimit-bucketing`, `event-dedup`, `timezone-boundary`, `config-precedence`, `index-staleness`.

**Điều kiện hợp lệ của một ngã rẽ** (runner từ chối chạy nếu vi phạm):
1. `contract` phải là câu nằm **nguyên văn** trong `state`. Một fork mà mọi lựa chọn đều biện hộ được mà không có câu đó thì không phải branch point, và nó sẽ tái tạo đúng cái "trần" của batch trước.
2. `oracle` phải là một candidate, và mọi candidate phải cùng `kind` với fork.
3. Mỗi candidate id phải khớp pattern id của sản phẩm và mỗi trường text ≤ 600 ký tự.
4. `why` phải nêu vì sao oracle thắng **chỉ từ `contract`**.

### 2.2 Bảy mươi call (đóng băng)

| Nhóm | Ngã rẽ | Mode | Số call |
|---|---|---|---|
| 1 | 30 fork | `select` | 30 |
| 2 | 30 fork | `score`, rubric 5 mức chung | 30 |
| 3 | 10 fork (`F1–F6`, `F13`, `F16`, `F22`, `F28`) | `score`, **đảo ngược danh sách candidate** | 10 |
| | | | **70** |

Nhóm 3 chỉ để đo **độ nhạy thứ tự**; đảo thứ tự không tạo thêm hạng mục độc lập.

### 2.3 Chỉ số và ngưỡng (đóng băng)

Đơn vị đếm là **ngã rẽ**, không phải call: ba view của cùng một fork không độc lập.

- `itemCorrect`: `select` chọn đúng oracle **và** `score` có oracle là đỉnh **duy nhất**.
- `commitRate`: tỉ lệ call có `status` là `selected` hoặc `scored`, trên **tổng 70 call** — kể cả 10 call đảo thứ tự — nên mẫu số của nó khác `itemCorrect` (30 ngã rẽ). Đó là chủ ý, không phải lệch: câu hỏi "model có chịu ra quyết định không" là câu hỏi theo call. **Đơn vị là call, không phải fork** — cùng con số mà verdict và báo cáo in ra (`commit ≥ 20/70 call`, không phải 20/30).
- `accuracyAmongCommits`: trong số call đã ra quyết định, bao nhiêu chọn đúng.
- `tied`: `score` có nhiều hơn một đỉnh. Hoà **không** tính là một pick; với `select`, hoà trả `main`/`uncertain` và tính là không ra quyết định.
- `positionFlips`: ở 10 fork nhóm 3, lựa chọn có đổi khi đảo thứ tự candidate hay không.
- `clientFailures`: reason thuộc danh sách lỗi của sản phẩm, **trừ `invalid_input`**. `invalid_input` bị từ chối trước cả resolver lẫn mạng, nên nó là **lỗi authoring của fixture**, không phải endpoint hỏng: nó được đếm và in riêng (`authoringErrors`), và một call như vậy được tính là *không chọn được oracle, không ra quyết định*. `control` cũng không bao giờ nằm trong danh sách này.
- **Trần client failure là 3, áp dụng cho cả hai stage** (đúng như §4): 1–3 failure lẻ không dừng batch và không làm batch vô hiệu; **> 3** thì batch vô hiệu và exit code khác 0. `invalid_input` thì ngược lại: chỉ cần một cái là đủ để tuyên bố case file sai và yêu cầu chạy lại, vì đó là bug của người viết fixture chứ không phải dữ liệu về model.

Quyết định:

| Kết quả | Kết luận |
|---|---|
| `itemCorrect ≥ 24/30` và `commitCalls ≥ 20/70` và `clientFailures ≤ 3` | đủ tin để chạy Stage 2 |
| `itemCorrect ≤ 19/30` | **dừng**, không chi tiền Stage 2: model không đủ tốt cho dạng câu hỏi này, bất kể trigger |
| `itemCorrect ≥ 24/30` nhưng `commitCalls < 20/70` | model chọn đúng nhưng ngưỡng 0.90/0.95 chặn — **đây là kết quả**, không phải lý do hạ ngưỡng trong batch này |
| `authoringErrors > 0` | không kết luận được: case file sai, sửa rồi chạy lại |
| `clientFailures > 3` | batch vô hiệu: chạy lại với endpoint sạch |
| còn lại | không kết luận; báo cáo là inconclusive |
| `positionFlips ≥ 3` | báo cáo như khuyết điểm độc lập (đáp án phụ thuộc thứ tự) |

Mọi tỉ lệ in kèm khoảng Wilson. Latency in kèm độ tán xạ quan sát được và **không** được phát biểu như hằng số theo mode: cùng một shape đã dao động ~10% giữa các lần và tới ~50% giữa hai lần chạy của cùng một batch `score`.

Ngân sách Stage 1: 70 request, ~0,005 USD, dưới 2 phút.

## 3. Stage 2 — ba arm, 2 dossier, mỗi dossier 3 ngã rẽ

Hai dossier của Stage 2 là `cache-isolation` (F1–F3) và `retry-amplification` (F4–F6).

### 3.1 Dossier và bài làm

Agent đọc `brief.json` (chứa cả 3 fork: goal, state có câu contract, candidates) và ghi `src/answers.json` dạng `{"F1":"<id>","F2":"<id>","F3":"<id>"}` — một id cho mỗi fork, mỗi fork độc lập. Public check chỉ kiểm well-formed + id thuộc tập hợp lệ (non-winner pass); private grader ngoài workspace kiểm đúng oracle.

### 3.2 Arm (đóng băng)

| Arm | Tool | Policy append | Credential |
|---|---|---|---|
| `B` | không có | `COMMON_POLICY` | **không có** |
| `J` | tool thật | `COMMON_POLICY` + **nguyên văn `rules/decision-maker.md`** + câu "mỗi fork là một ngã rẽ thật, dùng một call cho mỗi fork" | có |
| `E` | tool **rỗng** | y hệt J | không cần |

Khác biệt duy nhất giữa J và E là câu trả lời của tool. Description, schema, approval, loadMode và policy y hệt; self-check **so schema và description của hai tool và fail nếu khác**. Credential vô hình với agent (B không có vì không có tool nào dùng được nó).

**Tool rỗng** — đặc tả:

- Trả `{"status":"main","candidateId":null,"reason":"control",...}`, `latencyMs: 0`, `costUsd: 0`.
- `reason` là **`control`**, không phải `deferred`: nói "model đã cân nhắc và từ chối" là sai sự thật, và nó khác loại với một câu trả lời không-guidance thật. Vì vậy `control` **không** nằm trong danh sách reason lỗi của harness, và bộ đếm deferred/uncertain của E được in riêng, không gộp với J.
- Không giữ quota 5 call: quota là một phần của cái arm J trải nghiệm, không phải của đối chứng; một stub tự trả `call_limit` sẽ trông như lỗi client.
- Ghi mọi lần gọi vào `$HOME/.omp/agent/control-calls.jsonl` trong HOME cách ly (không vào workspace), để biết "nếu là tool thật thì đã bị hỏi gì".
- Không import `decide()` và không có đường nào tới mạng. Nó import đúng hai hằng số (`TOOL_NAME`, `TOOL_DESCRIPTION`) — không side effect.
- **Giới hạn phải ghi trong báo cáo**: E đo *chi phí gọi + phơi nhiễm placebo*, không phải chi phí gọi thuần, vì trong một phiên agent có thể học rằng tool rỗng rồi ngừng gọi. `latencyMs`/`costUsd` bằng 0 của E là hằng số của stub, không phải phát hiện về tốc độ.

### 3.3 Thứ tự chạy (đóng băng, 18 phiên)

`cache-isolation`: `B1,J1,E1,E2,J2,B2,B3,J3,E3`
`retry-amplification`: `E1,B1,J1,J2,E2,B2,B3,E3,J3`

Mỗi arm giữ mỗi vị trí một lần mỗi dossier. Chạy tuần tự.

### 3.4 Chỉ số

- **Chính**: `forkAccuracy` = số quyết định đúng oracle, trên **18 quyết định/arm** (9 mỗi dossier, gộp cả ba repeat).
- **Adoption**: so sánh trên **fork đầu tiên** thôi — E có thể đã học được tool vô dụng trước fork thứ ba, nên gộp lại sẽ đọc thành "phán đoán làm tăng số call" trong khi thực ra là phơi nhiễm placebo. Các fork sau là **đường phân rã**, in riêng. Vì call không được gắn mã fork, chỉ số quan sát được là **"tool được gọi trước lần ghi đầu tiên"**; nó là proxy và được ghi nhãn như vậy.
- **Đồng thuận phán đoán**: mỗi call thật, oracle có phải đỉnh duy nhất của nó không.
- **Thời gian**: `ΔJ = agentMs(J) − agentMs(B)`, `ΔE = agentMs(E) − agentMs(B)` theo từng cặp cùng dossier cùng repeat; tổng chi phí phiên dùng cùng mẫu số (main + JEV).
- **Phần quy cho phán đoán**: `attribution = median(ΔJ) − median(ΔE)`. `≥ 0` nghĩa là phần tăng thêm không đến từ phán đoán.

### 3.5 Quyết định (đóng băng)

1. `forkAccuracy(J) ≤ forkAccuracy(B)` và `forkAccuracy(E) ≈ forkAccuracy(B)` → không có lợi ích quy cho phán đoán ⇒ **dừng đầu tư vào tool**.
2. `forkAccuracy(J) > forkAccuracy(B)` nhưng `attribution ≥ 0` → phán đoán tốt hơn nhưng chưa đáng bật mặc định.
3. Call ở fork đầu của J `< 3/6` phiên → nút chặn là **cơ chế trigger**; bước tiếp theo phải là hook tự động, **không** phải hạ ngưỡng.
4. n = 18 quyết định/arm: mọi khác biệt là mô tả, khoảng Wilson in kèm, cấm dùng chữ "significance".

## 4. Ngân sách, dừng batch, artifact

- Request: Stage 1 **70**; Stage 2 gọi JEV tối đa 3 call/phiên × 6 phiên J = **18** (trần cứng của plugin vẫn là 5/phiên). Tổng trần **88**.
- Phiên model chính: **18** trong mẫu, cộng **1 phiên pre-flight arm E** không vào mẫu (xem dưới). Chi phí dự kiến: JEV ≈ 0,005 USD; model chính ≈ 19 × 0,03 ≈ **0,58 USD**. Thời gian ước tính 15–20 phút.
- Artifact ở `docs/research/jev-effective-protocol-2/runs/run-*`: `freeze.json`, `results.json`, `report.md`, transcript từng phiên (`<dossier>-<repeat><arm>.jsonl`), `stage1.frames.jsonl` ở Stage 1, `<label>.control-calls.jsonl` ở arm E.
- **Pre-flight của Stage 2 (đóng băng):** trước 18 phiên có đúng **một phiên arm E** trên dossier đầu, tốn ~0,03 USD và **0 request JEV**. Phiên đó không vào mẫu: nó không tham gia `ΔJ`/`ΔE`, không vào `n=18`, và được ghi riêng ở `stage2.preflight`. Nó tồn tại vì batch trước mất tiền ở đúng chỗ này — một lỗi driver chỉ lộ ra khi chạy phiên thật, không offline check nào thấy được; vi phạm của nó là **dừng cứng** trước mọi phiên trả phí.
- **Dừng batch** khi: `missingToolEnds`, `extension_error`, hash brief/public check/grader đổi, arm B gọi được tool, arm E chạm tool thật, arm J chạm tool rỗng, main model khác `9router/cx/gpt-5.6-terra:high`, hoặc **tổng client failure > 3**. Một `invalid_response` lẻ **không** dừng batch (bài học `run-GE0HaN`); `control` không bao giờ tính là client failure, và `invalid_input` là lỗi authoring chứ không phải client failure.
- Fail/timeout của model chính được giữ trong dataset và batch tiếp tục; chúng là dữ liệu.
- Không credential trong artifact; quét bằng membership trước khi bàn giao.

### 4.1 Chạy lại và những gì protocol này không gác

- **Chạy lại Stage 1 chỉ được phép vì lý do sức khoẻ endpoint**, tức `clientFailures > 0` (timeout/HTTP/network/contract), **không** được chạy lại vì `itemCorrect` thấp hay vì `commitRate` thấp. Cả hai file kết quả đều được giữ, và `attempts.md` ghi rõ lần chạy sau thay thế lần trước vì lý do đó — không im lặng ghi đè.
- **Stage 1 không có cổng nào gác chính nó**: 70 call là một phát, không có gì chặn giữa chừng, và không có arm đối chứng. Nếu `cases.json` lệch với `prepare()` thì nó hiện ra dưới dạng `authoringErrors`, không phải dưới dạng số liệu xấu.
- **Độ chính xác của Stage 1 không nói gì về việc agent có chịu gọi tool hay không** — đó là việc của Stage 2.
- **Stage 2 không đo được request HTTP thật trong phiên agent**: con số ở đó là tool call (1 request/call theo contract), và arm E là đối chứng cho *chi phí gọi + phơi nhiễm placebo*, không phải chi phí gọi thuần.

## 5. Freeze

`freeze.json` được ghi **trước request trả phí đầu tiên** ở cả hai stage. Nó hash byte thật của những thứ mà kết luận phụ thuộc vào: runner, `cases.json`, tool rỗng, `src/decision-maker.ts`, `rules/decision-maker.md`, `COMMON_POLICY`, policy append, `AGENTS.md`, brief/prompt/public check/private grader của hai dossier, thứ tự chạy — **và định nghĩa metric** (`METRIC_RULES`: ngưỡng, quy tắc đếm, quy tắc phân loại), vì tính lại median hay đổi cách phân loại reason sau khi xem kết quả cũng là một nước hậu nghiệm giống như sửa prompt. `freeze.json` cũng liệt kê 30 cặp `fork:oracle` để oracle không thể trôi.

Hash nào đổi giữa batch ⇒ batch vô hiệu, ghi rõ lý do, không trộn số.

Điều kiện để một lần chạy được coi là **kết quả**: `freeze.json` khớp đầu–cuối, không vi phạm điều kiện dừng, Stage 1 đủ 70 call, Stage 2 đủ 18 phiên. Thiếu một điều kiện thì báo cáo là incomplete kèm số đã thu — và ledger `docs/research/jev-effective-runs/attempts.md` được cập nhật **mọi** lần thử, kể cả lần hỏng, với số request **thật đã gửi** (không phải số reconcile).

## 6. Lệnh

```sh
bun docs/research/jev-effective-protocol-2/runner.ts --self-check   # offline, 0 inference
bun docs/research/jev-effective-protocol-2/runner.ts --stage1        # 70 request, ~0,005 USD
bun docs/research/jev-effective-protocol-2/runner.ts --stage2        # 18 phiên, ~0,55 USD
bun docs/research/jev-effective-protocol-2/runner.ts --render <results.json> <out.md>
```

Stage 2 chỉ nên chạy nếu Stage 1 đạt ngưỡng ở §2.3.
