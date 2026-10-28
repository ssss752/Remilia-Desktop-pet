# tight.py - step onto the pet and sample exstyle every 100ms
import time, sys
import mousetest as mt

h = mt.find()
r = mt.rect(h)
h_pet = r.bottom - r.top
cx, cy = r.left + h_pet // 2, (r.top + r.bottom) // 2
print("window rect", r.left, r.top, r.right, r.bottom, "target", cx, cy)
mt.move(cx, cy, steps=6)
for i in range(14):
    time.sleep(0.1)
    ex = mt.exstyle(h)
    print("%4dms ex=0x%08X  %s" % ((i + 1) * 100, ex, mt.flags(ex)))
