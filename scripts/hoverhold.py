# hoverhold.py - park the cursor on the pet, then leave; watch exstyle settle
import time, sys
import mousetest as mt

h = mt.find()
if not h:
    print("window not found"); sys.exit(1)
r = mt.rect(h)
h_pet = r.bottom - r.top
cx, cy = r.left + h_pet // 2, (r.top + r.bottom) // 2
print("-- move onto pet --")
mt.move(cx, cy, steps=8)
for i in range(4):
    time.sleep(0.7)
    mt.report(h, "over-pet #%d" % (i + 1))
print("-- leave --")
mt.move(200, 400, steps=6)
for i in range(4):
    time.sleep(0.7)
    mt.report(h, "left #%d" % (i + 1))
