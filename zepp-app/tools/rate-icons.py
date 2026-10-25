# Draws the thumbs up / down buttons under an answer as pill images for page/index.js rateButtons:
# python tools/rate-icons.py   (thumbs from Windows' Segoe UI Symbol font)
from PIL import Image, ImageDraw, ImageFont

W, H, S = 132, 72, 4  # button size on the watch, 4x supersampled
# Yellow (the TALK button is green) = the app's amber for notes and the waiting spinner.
DARK, YELLOW, INK, PRESS = (0x2b, 0x2b, 0x2b), (0xf5, 0xb0, 0x41), (0x1a, 0x1a, 0x1a), (0x55, 0x55, 0x55)
FONT = ImageFont.truetype('C:/Windows/Fonts/seguisym.ttf', 58 * S)
THUMB = {'up': '\U0001F44D', 'down': '\U0001F44E'}


def button(kind, bg, fg, path):
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W * S - 1, H * S - 1], radius=H * S // 2, fill=bg + (255,))
    x0, y0, x1, y1 = d.textbbox((0, 0), THUMB[kind], font=FONT)
    d.text(((W * S - (x1 - x0)) / 2 - x0, (H * S - (y1 - y0)) / 2 - y0), THUMB[kind], font=FONT, fill=fg)
    im.resize((W, H), Image.LANCZOS).save(path)


for kind in ('up', 'down'):
    button(kind, DARK, YELLOW, f'assets/active2/rate-{kind}.png')  # yellow thumb on dark
    button(kind, YELLOW, INK, f'assets/active2/rate-{kind}-on.png')  # the tapped thumb: solid yellow
    button(kind, PRESS, YELLOW, f'assets/active2/rate-{kind}-press.png')
