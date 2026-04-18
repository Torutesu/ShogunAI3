# -*- coding: utf-8 -*-
path = "/Users/torutano/Downloads/Shogun AI (1)/hifi/screens-meetings.jsx"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
lines[15] = "    {label:'Write weekly recap', jp:'\u9031\u5831'},\n"
lines[18] = "    {label:'Draft follow-ups',    jp:'\u8ffd\u8de1'},\n"
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print("recipes fixed")
