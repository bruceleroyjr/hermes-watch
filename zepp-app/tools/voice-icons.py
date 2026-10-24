# Draws the Voice on/off buttons (speaker with sound waves / speaker with an X) as pill images
# for page/index.js voiceButton: python tools/voice-icons.py
from PIL import Image, ImageDraw

W, H, S = 158, 80, 4  # button size on the watch (round(466 * 0.34) x 80), 4x supersampled
BLUE, GREY, PRESS, WHITE = (0x24, 0x71, 0xa3), (0x5d, 0x6d, 0x7e), (0x33, 0x33, 0x33), (255, 255, 255)

def button(on, bg, path):
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W * S - 1, H * S - 1], radius=40 * S, fill=bg + (255,))
    cx, cy = W * S // 2 - 14 * S, H * S // 2  # speaker left of centre, waves / X to its right
    u = S
    d.rectangle([cx - 16 * u, cy - 8 * u, cx - 6 * u, cy + 8 * u], fill=WHITE)  # magnet
    d.polygon([(cx - 6 * u, cy - 8 * u), (cx + 6 * u, cy - 19 * u), (cx + 6 * u, cy + 19 * u), (cx - 6 * u, cy + 8 * u)], fill=WHITE)  # cone
    if on:
        for r in (13, 24):
            d.arc([cx + 4 * u - r * u, cy - r * u, cx + 4 * u + r * u, cy + r * u], -50, 50, fill=WHITE, width=4 * u)
    else:
        x0, k = cx + 16 * u, 9 * u
        d.line([x0, cy - k, x0 + 2 * k, cy + k], fill=WHITE, width=4 * u)
        d.line([x0, cy + k, x0 + 2 * k, cy - k], fill=WHITE, width=4 * u)
    im.resize((W, H), Image.LANCZOS).save(path)

for on, name, bg in ((True, 'voice-on', BLUE), (False, 'voice-off', GREY)):
    button(on, bg, f'assets/active2/{name}.png')
    button(on, PRESS, f'assets/active2/{name}-press.png')
