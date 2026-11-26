# Synthesizer V

> 원문: [synthv.md](synthv.md). English가 source of truth다.

bridge는 Synthesizer V Studio 2 안의 Lua side-panel script다. 하나의 선택된 group을 따라 host API에서
playback, note, pitch, view mapping을 읽고 [bridge.md](bridge.md)의 app-owned pipe transport로 publish한다.

## One group

script는 group 하나만 publish한다. note는 SynthV의 `blick`, time은 second, pitch는 semitone과 cent를
쓴다. 앱은 이 데이터와 native canvas anchor로 screen rect을 재구성한다. Lua는 자기 window position을
알지 못한다.

## Host constraints

SynthV Lua에는 `io`, `os`가 있지만 socket, native module loading, `popen`, portable directory creation은
없다. scheduler도 `SV.setTimeout`뿐이다. Named pipe는 `io.open`으로만 동작하며 script는 channel pipe를
읽지 않는다. 128-byte regular `pipe-session` record를 읽고 `io.open(path, "wb")`로 세 write-only endpoint를
연다.

각 endpoint handle은 `setvbuf("no")`로 unbuffered가 되고 `write`, `close`에만 쓴다. Pipe write는
synchronous다. app reader가 block되면 SynthV UI thread에 backpressure가 걸리며 큰 `notes` snapshot이 가장
위험한 write다. side panel의 **Resend schedule** button은 이 작업의 intentional manual gate다.

## Pipe client

Lua는 `pipe-session`을 240 ms interval로 retry한다. fresh, checksum-valid VPR1 record만 받고 app session의
endpoint name을 유도한다. 처음 본 session은 candidate일 뿐이며, 같은 session의 heartbeat가 strictly newer로
전진한 것을 관찰한 뒤 세 endpoint를 모두 연다. `EPIPE`, write/open failure, advertised session 변경이면 모든
endpoint를 닫는다. open/write failure의 `(appSession, heartbeat)`는 session이 바뀌거나 heartbeat가 전진할
때까지 quarantine한다. `wb` mode는 기대한 endpoint가 없을 때 ordinary file을 만들 수 있다. 앱은 advertise
전에 reader를 만들고 teardown 전에 rendezvous를 withdraw해서 normal case를 막는다. stale regular file과
symlink는 의도적으로 지우지 않는다. Liveness proof는 unchanged fresh-but-dead advertisement 재사용을 막지만,
heartbeat 전진 관찰 후 endpoint open 전 force-kill race까지 제거하지는 못한다. macOS에서는 daemonized
out-of-process guardian이 그 race의 위험한 쪽을 막는다. app advertise 전에 이미 read descriptor를 보유하고,
더는 Electron descendant가 아니며, app death 뒤에는 모든 Lua writer가 닫힐 때까지 drain한다. Lua client는
바뀌지 않으며 FIFO를 만들지 않는다.

## Publication

script는 4 ms tick으로 돈다. 새 app connection에서 새로운 `scriptSession`을 만들고 `seq`, `scrollSeq`,
`notesSeq`를 reset한 뒤 session frame을 보낸다. 그다음 automatic exact recovery snapshot, 즉 full notes,
current scroll, current state를 publish한다. 이는 app이 예전 데이터를 보관했다고 가정하는 optimization이
아니라 reconnect마다 수행된다.

그 뒤 매 tick이 playhead, transport status, view를 sample하고, 무엇을 쓰는지는 무엇이 움직였는지에
달려 있다:

- **`state`** — playhead, transport status, `rev`, `scrollSeq`, `notesSeq` — 는 **transport가 playing
  이거나 looping인 동안 매 tick** 쓴다. 앱은 record를 읽는 그 순간에 playhead를 가장 새 record에 고정
  하므로, playback 중에는 record가 길어야 한 tick 묵은 것이어야 한다. 이 cadence는 절대 줄이지 않는다.
  playing status 아래에서 playhead가 멈춰 서 있을 때도 마찬가지다.
- **stopped인 동안**에는 그 값들 중 하나가 마지막으로 쓴 record와 다를 때, 또는 `STATE_KEEPALIVE_MS`
  **48** nominal millisecond 동안 하나도 쓰지 않았을 때만 `state`를 쓴다. 바뀐 것 없는 stopped record는
  SynthV의 UI thread에서 초당 250번의 `string.pack`과 synchronous write를 할 가치도, 그때마다 앱을 깨울
  가치도 없다.
- **`scroll`**은 여섯 view value가 바뀔 때만 쓴다. view가 바뀌면 `scrollSeq`가 움직이고, 그러면 그 값을
  가리키는 `state`도 같은 tick에 나간다 — 앱은 서로 일치하는 `state`와 `scroll`로만 snapshot을 compose한다.
- **`notes`**는 initial recovery, user request, 필요할 때 playback start, detected edit에 쓴다.

앱은 세 stream을 어떤 순서로든 받을 수 있으므로 sequence와 revision relation이 일치한 뒤에만 composed
snapshot을 accept한다.

keepalive는 liveness 계약의 script 쪽 절반이고 나머지 절반은 앱에 있다 —
[bridge.ko.md](bridge.ko.md#liveness) 참고. 이 값은 앱의 한계에 가깝게가 아니라 일부러 그 10분의 1로
잡았다. script가 자기가 약속하는 간격을 잴 수 없기 때문이다: 이 Lua host에는 1초보다 가는 wall clock이
없어서 경과 시간은 tick 수이고, 바쁜 editor 아래에서 `SV.setTimeout(4)`가 얼마나 늘어지는지는
**측정되지 않았다**.

session frame은 protocol/layout, `appSession`, `scriptSession`, script version, host information을 담는다.
`appSession`은 app rendezvous에서 오고, `scriptSession`은 Lua publisher가 reconnect할 때 바뀐다. 그 뒤
state, scroll, notes가 regular-channel rescan 없이 완전한 current app view를 recover한다.

## Notes and pitch

`getComputedPitchForGroup`은 group의 rendered pitch buffer를 MIDI note number로 돌려준다. 없을 수 있고
unvoiced frame은 문서의 `null` 대신 관측상 `0`이다. publisher는 unavailable padded sample에 `NO_CURVE`를
쓰고 renderer는 synthesized fallback contour를 쓸 수 있다. 이는 protocol fault가 아니라 측정된 host behavior다.

## View transform

`getTimePxPerUnit`, `getValuePxPerUnit`, `getTimeViewRange`, `getValueViewRange`가 `scroll` payload를 이룬다.
transform은 canvas-local이다. canvas의 screen position을 말하지 않으므로 앱이 macOS Accessibility 또는
Windows UI Automation과 결합한다. `viewTop`은 value range의 두 번째 edge이고 `viewBottom`은 첫 번째 edge다.

## Transport and looping

`SV.getPlayback()`은 `stopped`, `playing`, `looping`과 second 단위 playhead를 준다. loop bounds는 looping
중 backward playhead jump로 infer한다. 이는 smoothing hint일 뿐이고 앱은 received state로 re-anchor한다.

## Versions

script는 `minEditorVersion: 131330`을 선언한다. side panel은 script version, connection state, app/script
session, sequence counter, note count, last failure를 보인다. 앱이 Lua log를 볼 수 없을 때 host에서 보는
authoritative view다.
