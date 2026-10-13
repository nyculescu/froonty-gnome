# Feature: Pad noise slider

Status: **implemented**, working-tree only. Enabled by default
(Settings → Fan → **Pad noise slider in Quick Settings**).

The Quick Settings slider adjusts the llano V12 Ultra cooling pad directly.
It appears disabled until the pad is detected over USB. Moving the slider
sets its RPM target through `llano.py rpm`; Froonty does not change an ASUS
laptop power or fan profile.

## Noise stages

The slider runs from 300 to 2,800 RPM in the pad's own 50 RPM steps (its
display: 300, 350, 400, ...): the knob snaps to them while dragging, and
the keyboard and scroll wheel move one step. The noise stages are colored
dots on the slider's track, where the knob sits for that speed; hovering
one shows its name and RPM, and clicking it goes there. The stages come
from the measurements and RPM mapping in
[llano-v12-linux/NOISE.md](../../third_party/llano-v12-linux/NOISE.md)
(the dB column below is for reference; the slider does not show it). They
describe how the pad may sound; they do not cap the speed.

| Marker | RPM | Estimated dB at the ears |
|---|---:|---:|
| 🟢 Near-silent | 300 | ≈41 dB |
| 🟢 Almost quiet | 400 | ≈43 dB |
| 🟡 Comfortable | 600 | ≈50 dB |
| 🟠 Noticeably loud | 1,000 | ≈57 dB |
| 🟠 Loud | 2,000 | ≈69 dB |
| 🔴 Get out of here loud | 2,800 | ≈73 dB |

The estimates are not calibrated acoustic limits. Under the slider, a line
shows only when there is something to act on: the pad not connected, or a
llano command failing.

## Behavior

- Slider movement is briefly debounced; the latest target is sent while
  dragging, and an in-flight command is followed by the newest target.
- Froonty reads the pad's current RPM when it is connected and does not
  overwrite that speed on startup or reconnection.
- The slider and estimates do not affect the Fan tab slider, the pad's
  roller, or any ASUS laptop profile.
- A lock or llano command failure is shown under the slider. Disconnecting
  the pad disables the slider until it is detected again.

## Implementation

- `froonty@catalin/features/padNoiseSlider/quickSlider.js`: Quick Settings
  slider, USB detection and RPM updates.
- `froonty@catalin/features/padNoiseSlider/noiseStages.js`: RPM scale and
  its 50 RPM steps, stage markers and display estimates.
- Setting: `cooling-slider-enabled`.
