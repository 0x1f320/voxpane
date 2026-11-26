# The overlay surface

> 원문: **[overlay.md](overlay.md)**. 영어판이 원본이다.

effect가 그려지는 창. 하는 일이 셋이고, 서로 잡아당긴다:

1. **SynthV의 창 위에 정확히 있을 것** — 이동·리사이즈·zoom·모니터 전환·드래그를 거쳐도
   같은 사각형.
2. **절대 방해가 되지 않을 것** — 클릭도, 포커스도, 작업 표시줄 항목도, 그림자도 없고,
   SynthV를 보여줄 수 없을 땐 보이지 않을 것.
3. **절대 밀리지 않을 것.** frame을 늦게 따라가는 창은, 살짝 틀린 창과는 다른 방식으로
   고장 나 보인다.

코드: `main/overlay.ts`(창), `main/index.ts`(follow loop), `main/toolbar.ts`(도킹된 스트립),
그리고 두 helper crate의 `stick.rs`.

창 *안쪽*에서 note가 어디 있는지는 [geometry](geometry.ko.md). 이 문서는 창 자체를 다룬다.

## The window

```
transparent, frame: false, hasShadow: false, roundedCorners: false,
resizable: false, movable: false, focusable: false, skipTaskbar: true,
backgroundColor: "#00000000", show: false
```

여기에 `setIgnoreMouseEvents(true, { forward: true })` — 클릭은 SynthV로 통과하고, `forward`가
mouse-move 이벤트를 계속 오게 해서 hover 상태 같은 것이 여전히 동작할 수 있게 한다.

`webPreferences` 두 항목이 하중을 받는다:

- **`sandbox: false`.** preload가 native addon을 require하고 bridge endpoint worker를 시작한다.
  이것이 renderer로 하여금 bridge 재생 상태를 **프레임 경로에 IPC 없이** 읽게 해준다 —
  [hot path](#the-hot-path) 참조.
- **`backgroundThrottling: false`.** overlay는 절대 포커스를 받지 않고, Electron은 포커스
  없는 창의 rAF와 timer를 스로틀한다. 이게 없으면 스크롤할 때 overlay가 눈에 띄게 밀린다.
  그 대가로 Chromium은 숨겨진 창이나 한 번도 보인 적 없는 창의 rAF도 더는 멈추지 않는다.
  그래서 renderer는 자기 frame loop만으로는 누가 자기를 볼 수 있는지 알 수 없다. main이 알려
  준다 — [frames on demand](#frames-on-demand) 참조.

창은 숨긴 채로 만들고 helper가 frame을 보고한 뒤에야 보여준다 — 대상을 찾기 전에는 보여줄
것이 없다.

## Staying above SynthV

두 플랫폼이 정말로 다른 메커니즘을 쓰고, 어느 쪽도 일반화되지 않는다.

**macOS** — `setAlwaysOnTop(true, "floating")`. 단순하고, floating 레벨이면 메뉴 바와 싸우지
않으면서 SynthV 위에 앉기에 충분히 높다.

**Windows** — topmost가 아니라 **창 소유권**. `follow()`가 overlay의 HWND를 받아
`GWLP_HWNDPARENT`를 SynthV의 것으로 설정한다. 그러면 Windows가 overlay를 owner 바로 위에
유지하고, 최소화·복원을 함께 하고, 전역 topmost 창과 달리 SynthV 위에 쌓인 것이 overlay도
덮게 한다. topmost는 무관한 모든 애플리케이션 위에 overlay를 올려놓게 되므로 틀렸다.

> **진짜 `WS_CHILD`는 튜닝 문제가 아니라 막다른 길이다.** 두 번 시도됐다. `WS_CLIPCHILDREN`을
> 가진 부모는 — JUCE가 설정한다 — 자식이 덮는 영역을 자기 그리기에서 제외한다. 그래서 클라이언트
> 영역 전체를 덮는 overlay는 SynthV가 자기 자신을 다시 그리는 것을 아예 멈추게 만든다. 남의 창에서
> 그 스타일을 지우면 멈춤이 부모가 우리 위에 덮어그리는 것으로 바뀔 뿐이다. 소유권 더하기
> 쫓아가기가 Windows가 허용하는 최대치다.

프로세스 간 소유권은 Microsoft가 문서화한 것이 아니라 best-effort로 남고, 부착은 `follow()`
안에서만이 아니라 대상이 처음 나타나는 곳 어디서든 일어난다 — 대상은 보통 overlay handle이
넘겨진 *뒤에* 발견되기 때문이다.

## Following the frame

**macOS**는 SynthV의 창에 `AXObserver`를 설치한다. `AXMoved`, `AXResized`,
`AXWindowMiniaturized`, `AXWindowDeminiaturized`, `AXUIElementDestroyed`, 그리고 app element의
focused/main-window 변경. 그 이벤트들이 매끄러운 위치 갱신을 몰고, 옆에서 **10 Hz**
`CFRunLoopTimer`가 가시성과 점유를 다시 확인한다.

Accessibility 승인이 없으면 observer가 없으므로, helper는 모든 것을 모는 **60 Hz `CGWindowList`
폴링**으로 떨어진다. 상태가 어느 쪽이 돌고 있는지를 `mode: "ax" | "poll"`로 나른다.

frame은 좌상단 원점의 전역 **point**로 나오고, 그건 정확히 `win.setBounds()`가 원하는 것이다 —
그래서 macOS에서는 main process가 보고된 frame마다 `positionOverlay`를 `animate: false`로
직접 호출한다. 애니메이션된 이동은 정의상 대상보다 늦고, `native.disableAnimations`가 추가로
창에 `NSWindowAnimationBehavior::None`을 설정해서 AppKit이 자기 것을 얹지 못하게 한다.

**Windows**는 `WINEVENT_OUTOFCONTEXT`로 `SetWinEventHook`을 설치한다. 즉 Windows가 callback을
**설치한 스레드의 메시지 큐**로 전달한다는 뜻이고 — 그래서 메시지를 펌프하는 유일한 스레드인
Electron의 main thread여야 한다. worker에서 `start()`를 부르면 조용히 아무것도 받지 못한다.

거기서 frame은 물리 픽셀이므로, 창이 배치되기 전에
[DIP transform](geometry.ko.md#physical-pixels-points-and-dips)을 거친다.

```mermaid
flowchart TD
    subgraph MAC["macOS 신호"]
        ax["AXObserver<br/>moved · resized · miniaturized · destroyed"]
        macpoll["CGWindowList 폴링 @ 60 Hz<br/><i>Accessibility 없을 때만</i>"]
        mactick["timer @ 10 Hz<br/>가시성 + 점유"]
    end

    subgraph WIN["Windows 신호"]
        hook["SetWinEventHook · WINEVENT_OUTOFCONTEXT<br/><b>main thread 전용</b>"]
        dragt["drag timer @ 8 ms<br/>커서에서 예측"]
    end

    place["helper가 직접 SetWindowPos<br/><i>SynthV 자신의 이동과<br/>같은 메시지 배치에 들어감</i>"]
    emit(["onFrame → main process"])
    dip["DIP 변환<br/><i>macOS에서는 항등</i>"]
    branch{"native.follow?"}
    direct["<b>positionOverlay</b><br/>setBounds, animate: false"]
    debounced["<b>디바운스된 sync, 120 ms</b><br/>Electron의 인식만 맞춤 —<br/>창은 이미 있어야 할 곳에 있다"]

    ax & macpoll & mactick --> emit
    hook & dragt --> place --> emit
    emit --> dip --> branch
    branch -- "macOS · 아니오" --> direct
    branch -- "Windows · 예" --> debounced
```

## Techniques

### Native placement with debounced reconciliation

Windows에서는 helper가 직접 overlay를 배치한다. `SetWindowPos(SWP_NOACTIVATE | SWP_NOZORDER |
SWP_NOREDRAW)`를 **창이 사는 스레드에서** 호출하므로, 그 이동이 IPC와 `setBounds`를 거쳐 한
프레임 뒤에 오는 대신 SynthV 자신의 이동과 같은 메시지 배치에 들어간다.

그런데 Electron은 창이 보여질 때 자기가 아는 bounds를 다시 적용하므로, helper가 네이티브로
옮긴 뒤 overlay가 생성 크기로 되돌아가 버린다. 그래서 main은 **이동이 잦아든 뒤에** Electron의
인식을 맞춘다 — `BOUNDS_SYNC_MS` 120, frame 보고마다 타이머 재시작.

**왜 즉시가 아니라 디바운스인가:** 드래그 도중에 도착한 `setBounds`는 한 프레임 낡은 위치를
싣고 있어서 창을 뒤로 끌어당긴다. 화면에서 그건 *추격*이고, 잠깐 틀린 것보다 훨씬 눈에 띈다.

macOS에는 `native.follow`가 없으므로 다른 분기를 타고 직접 배치한다.

**깨지면:** 창이 보여질 때 800×400으로 튐(sync가 안 돎) · 드래그 중 overlay가 SynthV를 눈에
띄게 쫓아감(sync가 디바운스되지 않음).

### Cursor-based drag prediction

사용자가 SynthV의 타이틀 바를 드래그하는 동안, `EVENT_SYSTEM_MOVESIZESTART`가 8 ms 타이머를
시작해 창의 이동 이벤트를 기다리는 대신 **마우스**에서 위치를 예측한다:

```math
p = p_0 + (c - c_0)
```

$p_0$와 $c_0$는 드래그가 시작될 때의 창 frame과 커서 위치다.

진실과 예측이 `RESYNC_PX` 8 px보다 벌어지면 기준을 다시 잡고,

```math
\lVert p_{\text{reported}} - p \rVert > \text{RESYNC\_PX} \;\Rightarrow\; p_0, c_0 \leftarrow \text{now}
```

리사이즈에서는 **완전히 포기한다**: 리사이즈는 커서로 예측할 수 없고, 시스템이 화면 가장자리에
스냅시킨 창도 마찬가지다.

**깨지면:** 드래그 중 overlay가 창을 뒤따름(예측 꺼짐) · 앞서 나갔다가 되돌아옴(재기준화가 너무
느림) · 리사이즈 중 어긋남(예측을 포기하지 않음).

### Visibility gating

대상을 보여줄 수 없을 때는 overlay와 toolbar를 숨긴다. 아무것도 없는 위에 떠 있지 않도록.

**macOS**는 `CGWindowList`(화면상, desktop element 제외)를 훑어 대상이 앞의 창들에 얼마나 덮여
있는지 비율을 계산한다. `OCCLUSION_THRESHOLD` **0.15**를 넘으면 숨김으로 친다. 종료됐거나
숨겨진 애플리케이션, 그리고 화면에서 찾을 수 없는 창도 숨김으로 다룬다.

**Windows**는 `IsWindowVisible`과 `IsIconic`만 본다 — **거기엔 점유 판정이 없다.** 소유권이
이미 다른 창들이 overlay를 자연스럽게 덮게 해주기 때문이다.

Screen Recording은 의도적으로 요청하지 *않는다*: 이 판정은 bounds·pid·layer를 읽는데, 그 권한이
관장하는 것은 창 제목과 픽셀 캡처다.

main은 show와 hide를 전부 overlay의 renderer에 전달한다(`OverlayVisibility`, `overlay:shown`
channel). renderer가 이를 알 다른 방법이 없기 때문이다 —
[frames on demand](#frames-on-demand) 참조.

**깨지면:** SynthV를 덮고 있는 무관한 앱 위에 overlay가 떠 있음(macOS 점유) · 최소화했는데
overlay가 살아남음.

### The hot path

프레임 단위 경로는 의도적으로 프로세스 경계를 넘지 않는다.

| 단계 | 어디서 | 비용 |
| --- | --- | --- |
| bridge pipe frame receive | preload Web Worker | event-driven, rAF와 독립적 |
| 최신 bridge `state` 읽기 | preload memory cache | file I/O와 할당 없음 |
| canvas snapshot 갱신 | macOS: main IPC; Windows: preload native read | 약 250 ms마다, rAF call stack 밖 |
| 판단하고 그리기 | renderer | 단순 스크롤이면 transform 한 번 |
| 쉬는 frame loop 깨우기 | preload callback; main의 `overlay:shown` push | transition마다 한 번, 프레임마다는 절대 아님 |

bridge state와 draw 판단은 `contextBridge`를 통해 **overlay renderer의 프로세스 안에** 남는다.
저주기 canvas refresh는 macOS에서 Accessibility의 TCC subject가 permissions gate와 같아지도록
main을 거칠 수 있고, 의도적으로 프레임 경로 밖에 있다. 대안 — main이 bridge state를 읽고 매
프레임 renderer로 IPC — 은 프레임마다 왕복과 직렬화를 더하고, 그게 이 배치가 없애려고 존재하는
바로 그것이다.

frame loop는 Accessibility API 자체가 아니라 가장 최근 완료된 native canvas anchor를 읽는다.
macOS에서는 main이 cache된 window와 scrollbar AX element만 다시 읽고, 그 응답은 frame 사이에
도착한다. 느린 AX 왕복은 draw를 막는 대신 canvas anchor를 조금 낡게 만들 뿐이다. 실제 그리기에
쓰는 scroll과 zoom은 memory에 이미 sample된 bridge state로 다시 계산한다.

base note set은 cached schedule generation이나 canvas가 바뀔 때만 다시 만든다. 평범한 scroll과
zoom update는 같은 set을 유지하고 live bridge-derived viewport로 매핑한다. 별도 note pump는 없다.

**깨지면:** 스크롤 지연(뭔가 IPC 경로로 옮겨갔다) · GC 톱니(state 버퍼를 다시 할당하고 있다).

### Frames on demand

frame loop는 그릴 것이 있는 동안에만 돈다. 없으면 지운 frame을 하나 그리고
`requestAnimationFrame` 호출을 멈춘다. 다시 시작시키는 것은 event이고, polling하는 것은 없다.

**draw를 건너뛰지 않고 멈추는 이유.** frame의 비용은 frame이 만들어진다는 사실 자체 — renderer를
깨우고, canvas를 제출하고, SynthV 크기의 투명한 창을 composite하는 것 — 에서 나오지, 그 안에
무엇을 그리느냐에서 나오지 않는다. **관측값**(M2 Max, 60 Hz 6K 디스플레이에 창을 최대화, renderer와
GPU process의 CPU를 코어 하나 대비 %로): SynthV가 stopped인 동안 빈 scene을 매 frame 다시 그리는 데
약 14가 들었고, 모든 effect를 켠 playback은 약 21이었다. frame을 계속 요청하면서 아무것도 그리지 않는
loop도 멈춘 loop보다 약 1을 더 썼다. 그러니 레버는 덜 그리는 것이 아니다. 요청하지 않는 것이다.

**무엇이 "그릴 것"인가**는 `playback/frameLoop.ts`에서, 방금 그린 frame에 대한 여섯 가지 사실로
정한다:

| frame이 필요한 동안 | 이유 |
| --- | --- |
| 창이 보이고, playback이 돌고, effect가 하나라도 켜져 있다 | effect에 먹이를 주고 있다 |
| 앞서 배출된 것이 아직 비행 중이다 | 끝까지 가야 한다 — 창이 보이든 말든. 아래 참조 |
| 창이 보이고 debug mode가 켜져 있다 | debug rect는 scroll과 zoom을 따라가는데, 그건 stopped일 때 일어난다 |
| 창이 보이고 latency probe가 켜져 있다 | 매 frame sample한다 |

playback 하나만으로는 이 목록에 들지 않는다: effect를 전부 끄면 transport가 아무리 돌아도
그릴 것이 없다.

**무엇이 깨우는가.** 이 사실들은 세 가지 event 중 하나를 통해서만 참이 될 수 있고, 각 event는
`FrameLoop.wake`를 부른다. 이미 도는 loop에는 아무 일도 하지 않는 호출이다:

- **playback이 시작된다.** preload는 이미 모든 state record를 받고 있으므로 loop가 preload에
  부탁한다: loop가 멈출 때 `BridgeRuntime.awaitPlayback`을 arm하고, runtime은 다음으로 stopped가
  아닌 state를 compose하는 순간 callback을 부른다. 그 뒤 첫 frame이 같은 state를 읽으므로,
  playback이 시작될 때 울리는 note는 그 frame에서 strike된다. 이 wake는 one-shot이고, playback이
  시작되면 실제로 그릴 것이 생기는 경우에만 arm한다 — 숨겨진 창 뒤에서 playback이 이미 도는
  동안 arm하면 record마다 발화한다. 이미 들고 있는 state에 대해서는 절대 발화하지 않는다:
  playback 도중 조용해진 script는 cache에 playing state를 무기한 남겨 둔다.
- **preference가 바뀐다.** debug mode와 모든 effect 스위치는 `adopt`를 통해 들어온다.
- **창이 보이거나 숨겨진다.** main은 창을 show/hide할 때마다 `overlay:shown`을 push하고, 같은
  channel로 load 시점에 한 번 응답한다. push가 그 응답을 덮어쓰고 그 반대는 없다 — 둘은 따로
  이동한다. 초기 상태는 *숨김*이다. 그래서 만들어지고 한 번도 보인 적 없는 overlay는 아무것도
  그리지 않는다: SynthV 없이 앱만 떠 있는 상태가 그것이다.

latency probe는 뒤에 event가 없는 유일한 입력이다. 그 스위치는 frame 안에서 읽는 `localStorage`
flag라서, 쉬고 있는 overlay에서 켜면 다음 wake 때 효력이 생긴다.

**숨김은 창이 아니라 main이 하는 말이다.** `OverlayVisibility`는 `isVisible()`을 되읽지 않고
main의 의도를 추적한다. Windows에서는 Electron이 요청받지 않아도 system이 owned window를 owner와
함께 숨기고 되돌리기 때문이다.

**비행 중인 것은 이 모든 것보다 오래 산다.** playback을 멈추거나, 창을 숨기거나, effect를 끄면
effect에 *먹이 주기*가 멈춘다. loop는 남은 것이 없을 때까지 계속 step하고, 그런 다음에야 지우고
멈춘다. 숨겨진 창 뒤에서는 위치를 잡지 않은 채 step한다. 창이 몇 초 뒤에 돌아왔을 때 spark가
공중에서 이어지지 않게 하기 위해서다.

**loop는 새로 시작한 것으로 돌아온다.** 아무것도 그리지 않은 frame은 effect의 frame clock을
새로 시작시키므로, 쉰 뒤 첫 frame은 길이 0짜리 step이다 —
[effects.ko.md](effects.ko.md#frame-rate-independence).

**Pixi도 요청하면 안 된다.** Pixi 자신의 ticker가 frame을 계속 요청하면, 아무것도 잘못돼 보이지
않는 채로 이 모든 것이 무효가 된다 — [effects.ko.md](effects.ko.md#the-scene-graph).

**깨지면:** effect가 playback 시작을 놓치거나, 설정을 건드리기 전까지 overlay가 아무것도 그리지
않음(wake를 놓침 — `FrameDemand`에 새 입력이 생겼는데 그 뒤에 event가 없다) · 대기 중 CPU가
playback 때만큼 높음(무언가 아직 frame을 요청한다: Pixi ticker, 또는 조건이 이미 참인데 arm된
wake) · 마지막 spark가 화면에 얼어붙거나 잘려 나감(지우는 frame 전에, 또는 effect가 다 끝나기
전에 멈춤) · 창이 다시 나타날 때 낡은 spark가 비행을 마저 끝냄(숨겨진 동안 step하지 않고 얼려 둠).

### Sampling paired values together

짝으로 읽어야 하는 것은 같은 호흡에 읽어야 한다. 안 그러면 둘이 서로 다른 순간을 묘사하고
그림이 미끄러진다.

- **view mapping과 그것이 짝지어진 scroll 위치**는 `Transport.poll` 안의 같은 bridge state
  snapshot에서 온다. 넘겨받은 canvas snapshot은 native canvas와 window origin만 공급하므로,
  비동기 AX latency가 scroll latency가 될 수 없다.
- **window origin**은 `window.screenX`가 아니라 helper가 canvas rect과 함께 주는
  것(`vp.origin`)에서 온다. Chromium은 `screenX`를 자기 일정대로 갱신하므로 드래그 중에는 둘이
  어긋난다.

**깨지면:** 창을 드래그하는 동안 그림이 미끄러짐 · 스크롤 중 effect가 어긋나거나 늦게 따라옴 ·
debug box가 한두 frame 동안 잘못된 note layout으로 튐.

### Docking with hysteresis

toolbar는 대상 옆 `GAP` 8 px에 도킹하고 **현재 있는 쪽에 머문다.** 그 쪽이 대상의 모니터에
더 이상 들어가지 않을 때만 넘어간다. 그래서 왼쪽 도킹은 오른쪽에 자리가 다시 나도 유지되고,
왼쪽 가장자리 자체가 부족해질 때만 되돌아간다.

창은 자기 renderer가 실제로 그리는 것에 맞춰 크기가 잡히고 — renderer가 자기 content를 재서
`panel.resize`를 호출한다 — 그 측정이 도착할 때까지 숨겨져 있으므로 placeholder 크기는 보이지
않는다. main이 마지막 보고된 frame(`dockedFrame`)을 들고 있는 이유가 정확히, 측정이 그 뒤 아무
때나 도착할 수 있기 때문이다.

**깨지면:** 화면 가장자리 근처에서 toolbar가 좌우로 진동함(히스테리시스 상실) · 시작할 때 잠깐
크기가 틀린 패널이 보임(재기 전에 보여줌).

## Lifecycle

순서대로 알아둘 것:

- **single-instance lock**을 `app.quit`이 아니라 `app.exit`으로 잡는다 — 진 쪽은 `ready`가
  발생해서 두 번째 observer가 같은 SynthV 창에 붙기 전에 사라져야 한다.
- **`userData`를 고정한다.** `setName`(기본값을 다시 계산한다) 뒤, 그리고 그것을 읽는 무엇보다
  먼저 — single-instance lock의 소켓이 거기 살기 때문에 그것도 포함이다.
- **permissions gate**가 macOS에서는 다른 무엇보다 먼저 돈다: Accessibility 없이는 canvas
  discovery가 실패하므로, overlay는 존재하되 절대 정렬되지 않는다. 창은 올라와 있는 동안 1 Hz로
  trust 상태를 양방향으로 폴링한다 — macOS는 물어봤을 때만 알려주고, 스위치는 다시 꺼질 수도 있다.
- **dock 아이콘은 숨겨져 있고** overlay와 toolbar는 SynthV가 붙어 있을 때만 존재하므로, SynthV가
  닫혀 있으면 tray가 앱의 유일한 가시 표면이다. tray가 있을 때 `window-all-closed`가 종료하지
  않는 이유다.

## Invariants

| 불변식 | 깨지면 |
| --- | --- |
| Windows의 event hook은 main thread에서 설치한다 | Windows에서 frame 갱신이 아예 없음 |
| Windows에서 overlay는 topmost가 아니라 owned다 | overlay가 무관한 애플리케이션 위에 뜸 |
| Electron의 bounds는 이동이 잦아든 뒤에만 맞춘다 | 드래그 중 눈에 띄는 추격, 또는 보여질 때 튐 |
| `backgroundThrottling`은 꺼진 채로 둔다 | 스크롤할 때 overlay가 밀림 |
| 프레임 단위로는 아무것도 main으로 넘어가지 않는다 | 스크롤 지연이 돌아옴 |
| 그릴 것이 없으면 frame loop는 쉰다 | 대기 비용이 playback만큼 든다 |
| loop에 그릴 것을 줄 수 있는 모든 것이 loop를 깨운다 | effect가 playback 시작을 놓치거나 영영 돌아오지 않음 |
| 짝지어진 값은 같은 호흡에 샘플링한다 | 그림이 창에 대해 미끄러짐 |
| 대상을 보여줄 수 없으면 overlay를 숨긴다 | effect가 무관한 창 위에 뜸 |
