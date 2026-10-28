# dragtest.py - press on the pet, drag by (-140,-70), release; report window move
import time, sys
import mousetest as mt

h = mt.find_pet()
r = mt.rect(h)
h_pet = r.bottom - r.top
cx, cy = r.left + h_pet // 2, (r.top + r.bottom) // 2
print("before rect=(%d,%d) size=%dx%d target=(%d,%d)" % (r.left, r.top, r.right - r.left, r.bottom - r.top, cx, cy))
mt.move(cx, cy, steps=6)
time.sleep(0.3)
print("  ex over pet = 0x%08X [%s]" % (mt.exstyle(h), mt.flags(mt.exstyle(h))))
mt.down()
time.sleep(0.12)
for i in range(1, 13):
    mt.move(cx - 12 * i, cy - 6 * i)
    time.sleep(0.025)
time.sleep(0.1)
mt.up()
time.sleep(0.5)
r2 = mt.rect(h)
print("after  rect=(%d,%d) size=%dx%d" % (r2.left, r2.top, r2.right - r2.left, r2.bottom - r2.top))
print("moved by (%d,%d)  %s" % (r2.left - r.left, r2.top - r.top,
                                "OK" if abs((r2.left - r.left) + 140) < 40 else "FAIL"))
mt.move(200, 400, steps=6)
