import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { gunzipSync } from 'node:zlib'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// tar reads and writes through @preventive/archive, and says what GNU tar 1.35
// says: every expectation below was recorded from GNU tar in the C.UTF-8
// locale, with TZ=UTC, over the same bytes. The archives are GNU's own:
// `pkg` is a small package — directories, files, an executable, a link and
// an empty directory — made with `tar --sort=name --owner=dev:1000
// --group=staff:50`, every entry dated 2024-05-06 07:08:09 UTC; `pkg.tgz` is
// the same archive through `gzip -9 -n`; `dot.tar` is the package's contents
// made from `.`; `sp.tar` holds a hard link, a fifo and a character device.
const bytesOf = (base64) => Uint8Array.from(Buffer.from(base64.replace(/\s/gu, ''), 'base64'))
const PKG_TGZ = bytesOf(`
H4sIAAAAAAACA+3XT28cRRDG4T3XpxjEBTiYrrf6z8whSEjkyIVvQJwNXhKvLe8azLfnV87NSEGJtJsonpZaq1hlx36f6prp27d/
/Lg58Sqs0Vp++mjl8d+l6/3n+7Xx2r07deGb4kWjbqa2OcO6Pxx/v5umzevtXx+so+zNm81Xt27x/+3lz7/8+vLi+vUJ/XutH/Dv
T/y91bGZyup/8vXtRAfYZl3PdOX5f7Xbn/QZ8PHz30td5/9Z/e/u9xeHq8/kr3jiLxWt8/8s8/+bR/7DlW0vr24m2mB9GDy3+b+9
vj3+c8InwCfM/xpa5/+5/N/t9m9P/vwf4yP8VaNsJp36YrL6P/of7i6/uPe/Huv5P6f/bv96+3Dx5+Gz3P//+/7X+NL6/neGtX24
vbk7Tpc3+8NxepheTL6+/z239788/+92r072DPiE+d/5WOf/mf3399evtneHi+PD8ZzzX0P1iX8tbb3/n2W5ycKqNes2bLbFvJi7
uczDvJo3824+zGfzxVRMfI9MYaqmZuqmYZpNi0WxcAt+ZFhUi2bRLYbFbLFYLVbdqqzyP1arzWq3OqzOVhdrxZpbk7Wwxi/UrHVr
w9psbbFerLt1WQ/r1Tq/b7c+rM/WFxvFhtuQjbBRbTQb/DnDxmxjsbnY7DbL5rC52txs7jbz1842L7YUW9wW2RK2VFuaLd2WYQth
ZBrEUcijEEghkUIkhUwKoRRSKcRSqHuMjboMLpPL6DK7DC/Ty/jIzwnQlflSR4ZcddjUEaOToxOkk6QTpZOlR0JQR5xOnk6gTqJO
pE6mHBU2dcTKrZlNHclyntjUEa6TrhOvk68TsJOwt6SljpCdlJ2YnZydoDmIbOrI2gnbe/YAdeTtBO4k7kTuZO6E7qTuxM7hZmez
UEf0TvZO+E76TvxO/g6AI+AQ+JxdRR0KDoPj4EA4Eg6FY+FgOBq+ZPtl/9GAeAgP4SE8hIfwEB7CQ3jIs1Gpw0N4CA/hITyEh/BQ
9nM29GNHU5c9nU2dXZ1tnX2djY2H8BAeimx96vAQHsJDeAgP4SE8hIfw4BbLpg4P4SE8hIfwEB7CgzddNnUtDxN1eAgP4SE8hIfw
EB7CQ3io56mjDg/hITyEh/BgmLKpw0N4aOTxpA4P4SE8hIfwEB7CQ3gID815jqnDQ3gID+EhPISH8BAewkNLHvg88Rx5PAKPwCPw
CDwCj8Aj8Ag8wnM0UIdH4BF4BB6BR+AReAQegUcoZwh1eAQegUfgEXgEHpGTJkdNzprHYUNdjpucNzlwcuLkyMEj8Ag8Ao+oOZWo
wyPwCDwCj8Aj8Ag8Ao/AI1qOL+rwCDwCj8Aj8Ag8Ao/AI/CInnOOOjwCj8Aj8Ag8Ao/AI/AIPGLkQKQOj8Aj8Ag8Ao/AI/AIPAKP
mHNyUodH4BF4BB6BR+AReAQegUcsOWJzxhb71Of//XH37hRXwP+9/1U9ef7THWV9/p/9/nf8e3e55Q743f776cVP0376YdJ6HVzX
uta1rq9y/Qs0aEGyACgAAA==`)
const PKG_TAR = new Uint8Array(gunzipSync(PKG_TGZ))
const DOT_TAR = new Uint8Array(gunzipSync(bytesOf(`
H4sIAAAAAAACA+3Xy24kRRCF4V7HUxRiAyzaFSfyUrUYJCRmyYY3wJ4WbsZuW+62MG/PH73DSFxG6hqEK6WSLSt8O19kZOX2anPx
NbJ6reePrNcfz597ad6cunC+np9thrpZYD0fTz89DcPmja7t1Y/vv/v+h/fb+w8X9W+l/IV/e+Xfo8ZmGFf/i68vh8ePP9tmXW92
/1/vDxc+Az5h/re6zv8F/Z+eD9vj7WfzV/zR389Hwjr/l5j/X5wb4Hhru5vbh4FGWA+Dt7X/d/ePp98uegL8+/nfFW2d/8v43+0P
Hxc4/3v/5/7OiVA2gy5/NVn9r45PN//B97/W1/2/nP/+8GH3sv3l+Jnu/39+/wv19f1vibV7eXx4Og03D4fjaXgZ3g2+vv+9vf1/
t7++4BnwCe9/Jeo6/5f1PzzfX++ejtvTy2nZ+a+u8mr+e6vr/X+R5SYLK1atWbfJZvPR3M1lHubFvJo3824+mc+m0cT3yBSmYqqm
ZuqmyTRbjBZuwY8Mi2JRLZpFt5gsZiujFbciK/zGYqVaaVa6lcnKbHW06lZlNazyB1WrzWq3OlmdrY3W3JqshbVijb+3WevWJmuz
9dG6W5f1sF6sV+v8O936ZH22abTJbZJNYVOxqdrUbOK/nWyabR5tdptlc9hcbK42N5u7zYSRaRDHSB4jgYwkMhLJSCYjoYykMhLL
SN05NuoyuEwuo8vsMrxML+MjPydAV+ZLHRk6ITopOjE6OTpBOkk6UTpZeiQEdcTp5OkE6iTqROpk6oTqpOrE6iXFqCNZ9hMPdYTr
pOvE6+TrBOwk7DVpqSNkJ2UnZidnJ2g2Ig91ZO2EzW7koY68ncCdxJ3Incyd0J3Undid3L1ns1BH9E72TvhO+k78Tv4OgCPgEPiU
XUUdCg6D4+BAOBIOhWPhYDgaPmf7Zf/RgHgID+EhPISH8BAewkN4yLNRqcNDeAgP4SE8hIfwUPZzNvS5o6nLns6mzq7Ots6+zsbG
Q3gID0W2PnV4CA/hITyEh/AQHsJDeKjkHqEOD+EhPISH8BAewkN4CA/V3EzU4SE8hIfwEB7CQ3gID+GhlruOOjyEh/AQHsKDYcpD
HR7CQz23J3V4CA/hITyEh/AQHsJDeGjKfUwdHsJDeAgP4SE8hIfwEB6ac8PnjmfL4xF4BB6BR+AReAQegUfgEZ6jgTo8Ao/AI/AI
PAKPwCPwCDxCOUOowyPwCDwCDy4FPNTlpMlRk7PmPGyoy3GT8yYHTk6cHDl4BB6BR+ARJacSdXgEHoFH4BF4BB6BR+AReETN8UUd
HoFH4BF4BB6BR+AReAQe0XLOUYdH4BF4BB6BR+AReAQegUf0HIjU4RF4BB6BR+AReAQegUfgEVNOTurwCDwCj8Aj8Ag8Ao/AI/CI
OUdsztjRPu38fz7t7y5zBfzb+1/R6/tfp3w9/5e+/51+3d/suAN+dfh6ePftcBi+GbReB9e1rnWt63+5fgfvTWWMACgAAA==`)))
const SP_TAR = new Uint8Array(gunzipSync(bytesOf(`
H4sIAAAAAAACA+3VQQ6CMBCF4Vl7it6A1rbDeRqR6EoC6Pmt6IqFcUMD8n+baZpumpeZGbpKlmazOsapZvM6nV1Qpy6/8y7fq9co
JkoB92FMvTGyU0NXnZrzY/H8NYTf83c2qIrxW8r//Q/3qX5D+bcl+v97/nHe/9FbMZb+X1yTxnQQ7Hj+t9f2tq75b+vjsRaj9H+J
/C+pb9a2/18rwbgSy2nn+QMAAAAAAAAAAAD4H09P7romACgAAA==`)))

// Names longer than a header's field, as GNU 1.35 stores them in each format
// — in `L` and `K` blocks under --format=gnu, in pax `path` and `linkpath`
// records, split across the prefix under --format=ustar — and `git archive`'s,
// which opens with a global header. The name is a directory of 105 bytes.
const tarOf = (base64) => new Uint8Array(gunzipSync(bytesOf(base64)))
const LONG_TARS = {
  'gnu-long.tar': tarOf(`
H4sIAAAAAAACA+2Y3Y6CMBCFe71P0RcQOi2d3u798hImykokkiAaH39HY0z8WV0v2rBwvpsSmIQmwzk9TJZn+WfZbr7LerNWcTAC
F8VpFW5XQ95drk/3idhYpUuVgN22n3daq65t+2d1r57/Uxpp/eyQgFyBifb/KOrg/VHjFPxZ92yvNE8FE5PUOVLGMbNR2qfU/2K5
f1onZVU1vv5nQ/B/fuD/Dv4/Lv+v6maZ9YcenjtF/z/r/xf/d3f+L5FQG/h/dFb1B0QwYQZ7/sv/3xfOf5z/YPz69+Fe/4z8Py79
r+bdAnpD/v/D/IdZMoHSlGJzmP8g/8H/kf+Q/5D/oP+I+m/ifWBg8PkvhPBW/rOif4v8F51tgne8zv/2uv8mcDCY/yfpP8b/AAAw
SX4Ajx/gvwAqAAA=`),
  'pax-long.tar': tarOf(`
H4sIAAAAAAACA+2Zz06DQBCH9+xT7AsIM/tnFg69e/QVNgJCxGoADY/vEhtjIbUxKVsj8116WBJoJr/vN6VJeu/Hu9IXZden7cv+
8Xa8OBAgYwR8Mv8ERSDQEBICOI0CtDGIQo4iAm/94LvwKGKbIJJ89UO9W2n2S9IbDdIPzXO5Q5cDGm0zm1hrlTI5ZNPpw/IUD6eC
uSgxxj5l3Fk75R2dPeSe1Ff+Jxcc55+cAiFtzPwX5fuP14XLqornv4r/3Xz+VhH7P47/lYnt/6ppy2QYhxM9kDkDOTjugf+Y/xP+
1wv/oxYS2P+rUzccJc7/dfvfkFn2P3H/x+n/TLbN/ulaOwAqiL1/1L4rePf4U/0/2/+JwIb8Y4yH499/7H/2/5b8P31d9n/s93/O
/cr/U/4V+391ku////Tr3OOc/8HN/I+hEhT7PwbswW3TR7jH+f1fHec/tIUGfv8XZf6cYoZhmE3yAfzZwtwAJgAA`),
  'ustar-long.tar': tarOf(`
H4sIAAAAAAACA0vLzEnVK6koYaAhMAACMxMTEG1obmoA5huYGUFoMDBmMDQxMzQzNDAwNzZkMDAxNDUyZFAwYKADKC0uSSwCOiUl
tQyvOqCytDQSzM3Jz0vXraADoMz7GZlcDKNg5IJiOthBOP8boeZ/A3NzY4Mhnv+HSvyPZv9RMApGwSgYkQAAbNykDwAMAAA=`),
  'git.tar': tarOf(`
H4sIAAAAAAACA+3UQW7CMBCFYa85RW+Ax7Fn0kXPgpxg6AIalKZSj1+XZSrKBiKB/m8zlseSZT2NT/l7sz8MXT5s3kveltHdnq9U
9Vyrea3N6CSqqHhvjdR9iUnE7d0Cvj6nPNYrx2GY/jt3rT9/3INI4aUfjsfyMb1Z10ZT7Xfmt9m6po19sZ1Kra855VCCb0KxduXw
NE7r+9/xOw9m6fL81/Vs/qWR6BLzv0D+eZH8tf7xl/MPf/KP0Zwn/7vL/OYAAAAAAAAAAAAAADy8H3Je9WMAKAAA`),
}

// Names stored otherwise than the package gives them back: GNU's `./a` and
// `d/./b`, and a `./` in front of a long name in each format; and made with
// Python's tarfile, a directory stored as `d` without its slash, and hard
// links to `./f` and to a long name with `./` in front.
const STORED_TARS = {
  'lead.tar': tarOf(`
H4sIAAAAAAACA+3Kuw2AMBCDYddMkQnAR8JlnkiQAXjNTwg9HRRwX/PLktsu4WksNISzEgfWTe2vVj0kqKiQ0QtYSg9HvGBb1jQ7
h3Hab3/lljM+JzUwxhjzQwdlxlMrAAgAAA==`),
  'mid.tar': tarOf(`
H4sIAAAAAAACA+3Kuw2AMAyE4auZIhMQ2wRnHiLIALzmJ4SeDgrw1/w66Ubf+oRnUaEhnOXYU92kcrUScFBWJoodg5hEIhzhBduy
DrNzGKf99lduOeNzUgNjjDE/dABbgy4tAAgAAA==`),
  'gnu-dot-long.tar': tarOf(`
H4sIAAAAAAACA+3TQQ7CIBAF0Fl7Ci4gzAhMtx6AS5hYlNiUpFbT40saYxoXuJLEytsMgVnx86WSau9if3Khv8B3YMLGzDN5n0hs
X+f5nojRgnBQwO06HgYhYIhxzO19ev9RUnUp/O1UgPKha+U4rfEba/4Zi/5TY5+9592i8xrIMDEhNpoANRuNILBk/4/tPbuX1rxf
X/7nsKklqKqq+kMPyFav6wAMAAA=`),
  'pax-dot-long.tar': tarOf(`
H4sIAAAAAAACA+3TTQ6CMBCG4a45BRewftNOW1hwGKIgJPgTrYbjWyNxgYkr7UL6bLqYWTRpX7kejofdavwlBJZZ4Gl+QjkliC1Z
ApwmAW3AEPkoIrhefH0OVxHLRMrmp9p3lYzwESbrth8a6UefaeS17/dNRa4EsTaFkcYUjlHCPaab9ykpxSWKTCRfIOP2T85M3Vv1
6h/Qs/4tu9A/Yva/bW4f98Ja2/7f+3d9CilJkmSJ7kiPXs0ADAAA`),
  'ustar-dot-long.tar': tarOf(`
H4sIAAAAAAACA+3PUQpAQBAG4Hl2ChewZljjPMouaqNYcnyLdyXxYr6Xv6m/acZ2zii/engRBqz1nlQWeMzI2ZmHHEgzMSGWOQFq
4oIhRvjAPPlqDKfUZrnshZq1N/aq1A19k6wfePJ+20UghBDifzZNuzPiAAgAAA==`),
  'nodir.tar': tarOf(`
H4sIAAAAAAACA+3RMQ6DMBBE0a05hW8QL3jX54lkfACScH4MVGnoQAL914y8msLSFDlfbLLZmpotbu/o/Z470eTq2nqDtnt2yxLs
gr/J7/N9TyFIGefDXqvVKo9TXvWS/T2lg/37//3XdAmR/U9XOwEAAAAAAAAAAAAAAABwUwsZ5SvBACgAAA==`),
  'hardlink.tar': tarOf(`
H4sIAAAAAAACA+3TMQ7CMAyFYc+cIido7TZxzoNELWYKPT+hTAywgaryf8uTLQ9eXsj3aeM5P9Jq0XVWH565GsSym5tqHa3tq5dR
kv7gN7nN1+MlJTlNy8e7dhYhuxMHwR87b6L/+tp/UytVknV90H8AAAAAAAAAAAAAAADgvTtZ7erAACgAAA==`),
  'longlink.tar': tarOf(`
H4sIAAAAAAACA+3WSwrCMBSF4Tt2FdmAbdI2ydS53YSgVVEq+MLlG62IKOrIIM3/TVJCoIObw0mWZ/mo3rTzetmu5Dd0592qja3u
392+99aKqiWCw24/2SoliVqH0Q9PEeSNIM35X0LtqmvGjbe33LviIfOFmMoZZ0LySyO6dM4WonTM/E9nx4/nwrGmh1e4GZCBlGV/
0f/utf+dqDH9H2H+vABStojwj+/9r5/73/qQfxPjcibe/wAAAAAAAAAAAOiXM7mvugYAKAAA`),
}

// Pax records, by Python's tarfile: keywords GNU does not know on two of
// three entries, with a global one it takes without a word (`warn.tar`); a
// volume label; an access time GNU finds malformed, in an entry's header and
// in a global one; and entries dated before 1970, now and in 2100.
const PAX_TARS = {
  'warn.tar': tarOf(`
H4sIAAAAAAACA+3Wy0rEMBQG4Kz7FHmCTE4mTWYT8IIwA7MQBcFloBeEcbRX2z69LSreUBcypUP/b5OSE+ii/c+JWIjFyaVv1rGP
4pwdhHzx0yolmffnYZ8kWWI8ZSOoitLn/evZPJHmWZa54m4X78uAwcyIKeRfya/5VzJkvEH+D27Fu65zdbDibdu6J3SAmUlG+PGH
UButh5Vs+Jp1oz5kXvVzyJAhKe2S+n2rtWFcjpn/KK5/PfdX/Vi/PxI/7/zTRPNvkX/kH+Zw/ydF3+//Fvf/MSwV327OTq/O15ub
C9H4ssxFVcS58C5KnQtUyK/72vb2c60OlH4rJMnOp4XbP0TV/SPayZH1fzXN+d8fw/zH/AcAAAAAAAAAgH96Brk5IEIAKAAA`),
  'label.tar': tarOf(`
H4sIAAAAAAACA+3TsQrCMBDG8Zt9ij5BmqQxnQQ3HURcfIBI41QRalv6+LYo6KJOFkr/v+XCJZDh7lOpSteH0G1jKGIlf6EfPlWt
rX+dh77R1mSSdDKC5laHqv9e5snaZLM/qvZaNpeoynCK5Wq3EMzEeYTFH0LtnRuqyZfP3Hv7lnkrxnnjjdZ5Zvp+7pyXRI+Z/yK2
X9/9up/q/Mk6AAAAAAAAAAAAAADApN0B9uNtZQAoAAA=`),
  'badatime.tar': tarOf(`
H4sIAAAAAAACA+3TMQrCMBSA4Td7ip6gfS+m6SQ4OnqFQCM4uNQqPb6tCrqok4HS/1sSkkCG5C+rstru47BLsU2d/IU+fBpVzb/m
07qpM5VikAwu5z524/WyTOaK2B9PaVMPK8HiHDJ8/Cnq4O+NW1M/uw/urXkn5oMFU23WNq433gcpNGf/bbp+Pfdrf67vT/UAAAAA
AAAAAAAAAACzdgMiCyIsACgAAA==`),
  'globatime.tar': tarOf(`
H4sIAAAAAAACA+3TsQ6CMBDG8Zt9Cp4A7qC0k4mjo69QQzUOLojGxweiiS7qJAnh/1uuuTbpcPflRV5sdvG+TbFJrfyFPnyqqla/
zmPf1IJKdpQJXC9dbIfvZZmsymJ3Oqf1PjYrwdIcJlj8MdTeubFaqJ+59+Vb5ksx582baqhs6AfnvGQ6Zf6bdPv67tf9XOdP6AEA
AAAAAAAAAAAAAGatB1/LJUsAKAAA`),
  'times.tar': tarOf(`
H4sIAAAAAAACA+3VPQ7CMAyGYc+cIkewGzc5D1LLhKhUGjg8A4QysAFL+RHvs1iOvVmfMmw7WZpWyf1aLbc695qaW501cr47qXmb
TILKG5T9tB5DkK4/PNx7Nv9Rm5Xgj+2G41fk3zxZMtUcrb7nrE7+yT8Wv3+Zyth/Pv+xLtRvP7rWualbJv/kHwAAAAAAAAAAAADw
qgsTGIu7ACgAAA==`),
}

const SOURCES = {
  'pkg.tar': PKG_TAR,
  'pkg.tgz': PKG_TGZ,
  'dot.tar': DOT_TAR,
  'sp.tar': SP_TAR,
  ...LONG_TARS,
  ...STORED_TARS,
  ...PAX_TARS,
  'notes.txt': 'plain text\n',
  'empty.zip': Uint8Array.of(0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)),
  'pkg/README.md': '# pkg\n',
  // xz's first six bytes, which is all GNU looks at.
  'fake.xz': Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x6a, 0x75, 0x6e, 0x6b),
  'trailing.tgz': Uint8Array.of(...PKG_TGZ, ...Buffer.from('plain text\n')),
  'cut.tgz': PKG_TGZ.subarray(0, 300),
}

// Every listing prints a time, which is local time unless TZ says UTC.
async function terminal(sources = SOURCES) {
  const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
  await t.run('export TZ=UTC')
  return t
}
const result = (stdout = '', { stderr = '', exitCode = 0, cwd = '/repo', notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd, notes, unsupported })

// A gap reports on every channel: the command fails, says why, and the run
// carries the diagnostic where a redirect cannot hide it.
async function gap(t, command, detail, stderr) {
  const r = await t.run(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

const NAMES = 'pkg/\npkg/README.md\npkg/bin/\npkg/bin/run.sh\npkg/empty/\npkg/link\npkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n'
const LONG = [
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/',
  '-rw-r--r-- dev/staff         6 2024-05-06 07:08 pkg/README.md',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/bin/',
  '-rwxr-xr-x dev/staff        19 2024-05-06 07:08 pkg/bin/run.sh',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/empty/',
  'lrwxrwxrwx dev/staff         0 2024-05-06 07:08 pkg/link -> README.md',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/src/',
  '-rw-r--r-- dev/staff        19 2024-05-06 07:08 pkg/src/index.js',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/src/lib/',
  '-rw-r--r-- dev/staff      1492 2024-05-06 07:08 pkg/src/lib/numbers.txt',
  '-rw-r--r-- dev/staff        34 2024-05-06 07:08 pkg/src/lib/util.js',
]
const lines = (...picked) => picked.map((line) => line + '\n').join('')

describe('tar lists what an archive holds', () => {
  it('names every entry, and with -v describes it', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tf pkg.tar'), result(NAMES))
    assert.deepEqual(await t.run('tar -tvf pkg.tar'), result(lines(...LONG)))
    // -t is a verbosity of its own each time it is given.
    assert.deepEqual(await t.run('tar -ttf pkg.tar'), result(lines(...LONG)))
    assert.deepEqual(await t.run('tar --list --list -f pkg.tar'), result(lines(...LONG)))
    // The old style: the letters of a first word with no dash, their
    // arguments taken from the words after it.
    assert.deepEqual(await t.run('tar tvf pkg.tar pkg/src'), result(lines(...LONG.slice(6))))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --numeric-owner pkg/README.md'), result('-rw-r--r-- 1000/50           6 2024-05-06 07:08 pkg/README.md\n'))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --utc pkg/empty'), result(lines(LONG[4])))
    // A time in UTC is a time in the long listing, which --utc asks for
    // whatever -v says.
    assert.deepEqual(await t.run('tar -tf pkg.tar --utc pkg/README.md'), result(lines(LONG[1])))
    // -O lists on stderr, though nothing is extracted to stdout.
    assert.deepEqual(await t.run('tar -tOf pkg.tar pkg/README.md'), result('', { stderr: 'pkg/README.md\n' }))
    assert.deepEqual(await t.run('tar -tvOf pkg.tar pkg/README.md'), result('', { stderr: lines(LONG[1]) }))
  })

  it('describes what is not a file the way GNU does', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tvf sp.tar'), result(lines(
      'drwxr-xr-x 0/0               0 2024-05-06 07:08 sp/',
      'crw-r--r-- 0/0             1,3 2024-05-06 07:08 sp/cdev',
      '-rw-r--r-- 0/0               5 2024-05-06 07:08 sp/f',
      'prw-r--r-- 0/0               0 2024-05-06 07:08 sp/fifo',
      'hrw-r--r-- 0/0               0 2024-05-06 07:08 sp/hard link to sp/f',
    )))
  })

  it('reads a gzip archive with -z, and without it from a file that says it is one', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tzf pkg.tgz'), result(NAMES))
    assert.deepEqual(await t.run('tar -tf pkg.tgz pkg/src/lib'), result('pkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n'))
    assert.deepEqual(await t.run('tar -tvzf pkg.tgz pkg/bin/run.sh pkg/link'), result(lines(LONG[3], LONG[5])))
    // stdin is read with -z, and GNU asks to be told rather than looking.
    assert.deepEqual(await t.run('cat pkg.tgz | tar -tz pkg/README.md'), result('pkg/README.md\n'))
    assert.deepEqual(await t.run('cat pkg.tgz | tar -t'), result('', { stderr: 'tar: Archive is compressed. Use -z option\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    assert.deepEqual(await t.run('cat pkg.tar | tar -tv pkg/bin'), result(lines(LONG[2], LONG[3])))
  })

  it("passes gzip's own complaint on, and its status", async () => {
    const t = await terminal()
    const child = 'tar: Child returned status 1\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('tar -tzf pkg.tar'), result('', { stderr: '\ngzip: stdin: not in gzip format\n' + child, exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tzf empty.zip'), result('', { stderr: '\ngzip: stdin: not in gzip format\n' + child, exitCode: 2 }))
    // Garbage after the last member is a warning gzip exits 2 on, having
    // written every member — which tar reads, before the status stops it
    // short of saying what it did not find.
    const garbage = '\ngzip: stdin: decompression OK, trailing garbage ignored\ntar: Child returned status 2\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('tar -tzf trailing.tgz pkg/README.md'), result('pkg/README.md\n', { stderr: garbage, exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf trailing.tgz pkg/nothere'), result('', { stderr: garbage, exitCode: 2 }))
    // A member cut short leaves gzip writing out what it had inflated by
    // then, which the runtime's stream does not say.
    await gap(t, 'tar -tzf cut.tgz', 'damaged gzip stream', 'tar: the gzip stream is damaged, and how much of it GNU gzip would inflate is not known here\n')
  })

  it('matches operands against what is stored, and reports what it did not find', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("tar -tf pkg.tar pkg/nothere 'pkg/*.md' pkg/src/"), result('pkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n', {
      stderr: 'tar: pkg/nothere: Not found in archive\ntar: Pattern matching characters used in file names\n'
        + 'tar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning\n'
        + 'tar: pkg/*.md: Not found in archive\ntar: Exiting with failure status due to previous errors\n',
      exitCode: 2,
    }))
    // --no-wildcards silences the warning, wherever it stands.
    const missing = result('', { stderr: 'tar: pkg/*.md: Not found in archive\ntar: Exiting with failure status due to previous errors\n', exitCode: 2 })
    assert.deepEqual(await t.run("tar -tf pkg.tar --no-wildcards 'pkg/*.md'"), missing)
    assert.deepEqual(await t.run("tar -tf pkg.tar 'pkg/*.md' --no-wildcards"), missing)
  })

  it('reads no archive from the terminal and writes none to it, as GNU does', async () => {
    // Nothing can be typed into this terminal, and it shows text: stdin is
    // the terminal unless something was piped or redirected into it, and
    // stdout is unless it goes on down a pipe or into a file. GNU asks before
    // anything but the command line itself.
    const t = await terminal()
    const refusing = (way) => result('', { stderr: `tar: Refusing to ${way} archive contents ${way === 'read' ? 'from' : 'to'} terminal (missing -f option?)\ntar: Error is not recoverable: exiting now\n`, exitCode: 2 })
    for (const line of ['tar -t', 'tar -tf -', 'tar -xz', 'tar -tv pkg/README.md']) assert.deepEqual(await t.run(line), refusing('read'), line)
    for (const line of ['tar -c pkg', 'tar -czvf - pkg', 'tar -c --format=pax pkg']) assert.deepEqual(await t.run(line), refusing('write'), line)
    // A pipe and a redirect are no terminal.
    assert.deepEqual(await t.run('tar -cf - --owner=dev:1000 --group=staff:50 pkg/README.md | tar -t'), result('pkg/README.md\n'))
    assert.deepEqual(await t.run('tar -t < pkg.tar'), result(NAMES))
  })

  it('says what GNU says of what is not an archive at all', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -t < /dev/null'), result('', { stderr: 'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf notes.txt'), result('', { stderr: 'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf notes.txt pkg/README.md'), result('', {
      stderr: 'tar: This does not look like a tar archive\ntar: pkg/README.md: Not found in archive\ntar: Exiting with failure status due to previous errors\n',
      exitCode: 2,
    }))
    assert.deepEqual(await t.run('tar -tf missing.tar'), result('', { stderr: 'tar: missing.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf pkg'), result('', {
      stderr: 'tar: pkg: Cannot read: Is a directory\ntar: At beginning of tape, quitting now\ntar: Error is not recoverable: exiting now\n',
      exitCode: 2,
    }))
  })

  it('reads a long name from wherever GNU stores one', async () => {
    const t = await terminal()
    const dir = `long-${'x'.repeat(100)}`
    const all = lines(
      `drwxr-xr-x dev/staff         0 2024-05-06 07:08 ${dir}/`,
      `-rw-r--r-- dev/staff         3 2024-05-06 07:08 ${dir}/file.txt`,
      `hrw-r--r-- dev/staff         0 2024-05-06 07:08 ${dir}/hard link to ${dir}/file.txt`,
      `lrwxrwxrwx dev/staff         0 2024-05-06 07:08 ${dir}/link -> ${dir}/file.txt`,
      '-rw-r--r-- dev/staff         2 2024-05-06 07:08 s',
    )
    assert.deepEqual(await t.run('tar -tvf gnu-long.tar'), result(all))
    assert.deepEqual(await t.run('tar -tvf pax-long.tar'), result(all))
    assert.deepEqual(await t.run('tar -tvf ustar-long.tar'), result(lines(
      `-rw-r--r-- dev/staff         3 2024-05-06 07:08 ${dir}/file.txt`,
      '-rw-r--r-- dev/staff         2 2024-05-06 07:08 s',
    )))
    assert.deepEqual(await t.run('tar -tvf git.tar'), result(lines(
      'drwxrwxr-x root/root         0 2024-05-06 07:08 p/',
      '-rw-rw-r-- root/root         2 2024-05-06 07:08 p/a',
    )))
  })

  it('warns of a pax keyword GNU does not know as it comes to its entry', async () => {
    const t = await terminal()
    const warn = (keyword) => `tar: Ignoring unknown extended header keyword '${keyword}'`
    const row = (name) => `-rw-r--r-- dev/dev           2 2024-05-06 07:08 ${name}`
    assert.deepEqual(await t.run('tar -tvf warn.tar 2>&1'), result(lines(warn('zzz'), warn('yyy'), row('f0'), row('f1'), warn('LIBARCHIVE.xattr.user.a'), warn('SCHILY.fflags'), row('f2'))))
    // Of every entry it reads, whether asked for or not.
    assert.deepEqual(await t.run('tar -xvf warn.tar -C /tmp f1 2>&1'), result(lines(warn('zzz'), warn('yyy'), 'f1', warn('LIBARCHIVE.xattr.user.a'), warn('SCHILY.fflags'))))
  })

  it('refuses a pax record it cannot answer for as GNU does', async () => {
    // GNU lists a volume label as an entry of its own, and complains of a
    // time it cannot read and goes on; the package does neither.
    const t = await terminal()
    await gap(t, 'tar -tf label.tar', 'extended header', 'tar: GNU.volume.label: records of multi-volume and incremental archives are not supported\n')
    await gap(t, 'tar -tf badatime.tar', 'extended header', 'tar: atime=5x: extended header times GNU would reject are not supported\n')
    await gap(t, 'tar -tf globatime.tar', 'extended header', 'tar: atime=bad: extended header times GNU would reject are not supported\n')
  })

  it('refuses an archive whose names it cannot give back as stored', async () => {
    // The package hands `./a` out as `a`, `d/./b` as `d/b` and a directory
    // as its name without a slash, however it was stored; GNU prints each
    // name as stored, so an archive holding one the package changed is
    // refused, wherever in the archive the name sits. An entry for the
    // archive's own root is refused as well.
    const t = await terminal()
    const dot = (name) => `tar: ${name}: names stored with \`.' segments are not supported\n`
    const dir = `long-${'x'.repeat(100)}`
    await gap(t, 'tar -tf dot.tar', 'dot-segment names', dot('./'))
    await gap(t, 'tar -tf lead.tar', 'dot-segment names', dot('./a'))
    await gap(t, 'tar -tf mid.tar', 'dot-segment names', dot('d/./b'))
    for (const format of ['gnu', 'pax', 'ustar']) await gap(t, `tar -tf ${format}-dot-long.tar`, 'dot-segment names', dot(`./${dir}/file.txt`))
    await gap(t, 'tar -tf nodir.tar', 'directory names', 'tar: d: directories stored without a trailing slash are not supported\n')
    await gap(t, 'tar -tvf hardlink.tar', 'dot-segment names', dot('./f'))
    await gap(t, 'tar -tvf longlink.tar', 'dot-segment names', dot(`./${dir}/f`))
    // However the archive arrives: through gzip, down a pipe, under a name
    // that says it is compressed when its first block says it is not.
    await gap(t, 'gzip -c lead.tar | tar -tzf -', 'dot-segment names', dot('./a'))
    await gap(t, 'cat lead.tar | tar -tf -', 'dot-segment names', dot('./a'))
    await t.run('cp lead.tar /tmp/lead.tar.xz')
    await gap(t, 'tar -tf /tmp/lead.tar.xz', 'dot-segment names', dot('./a'))
    // And before anything is extracted.
    await gap(t, 'tar -xf mid.tar -C /tmp', 'dot-segment names', dot('d/./b'))
    assert.equal((await t.run('ls -A /tmp')).stdout, 'lead.tar.xz\n')
  })
})

describe('tar reads its command line as GNU does', () => {
  const usage = (message, exitCode = 2) => result('', { stderr: `tar: ${message}\nTry 'tar --help' or 'tar --usage' for more information.\n`, exitCode })

  it('says what is wrong with it in GNU words', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar'), usage("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"))
    assert.deepEqual(await t.run('tar -ctf x'), usage("You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option"))
    assert.deepEqual(await t.run('tar -cf x.tar'), usage('Cowardly refusing to create an empty archive'))
    assert.deepEqual(await t.run('tar cf'), usage("Old option 'f' requires an argument."))
    assert.deepEqual(await t.run('tar -tf'), usage("option requires an argument -- 'f'", 64))
    assert.deepEqual(await t.run('tar --file'), usage("option '--file' requires an argument", 64))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --verbose=1'), usage("option '--verbose' doesn't allow an argument", 64))
    assert.deepEqual(await t.run('tar -tf pkg.tar --strip-components=abc'), usage('abc: Invalid number of elements'))
    assert.deepEqual(await t.run('tar -tf pkg.tar -f pkg.tar'), usage("Multiple archive files require '-M' option"))
    assert.deepEqual(await t.run('tar -cf x -b 0 pkg'), usage('0: Invalid blocking factor'))
    assert.deepEqual(await t.run('tar -tf pkg.tar -b 2147483648'), usage('2147483648: Invalid blocking factor'))
    assert.deepEqual(await t.run('tar -cf x --format=foo pkg'), usage('foo: Invalid archive format'))
    // argmatch quotes in the locale's own marks.
    assert.deepEqual(await t.run('tar -cf x --sort=n pkg'), result('', {
      stderr: 'tar: ambiguous argument ‘n’ for ‘--sort’\nValid arguments are:\n  - ‘none’\n  - ‘name’\n  - ‘inode’\n',
      exitCode: 2,
    }))
  })

  it('reports an option it does not carry as a gap', async () => {
    const t = await terminal()
    await gap(t, 'tar -cjf x.tbz pkg', '-j', 'tar: unknown option: -j\n')
    await gap(t, 'tar -tf pkg.tar --wildcards', '--wildcards', 'tar: unknown option: --wildcards\n')
    // GNU holds a whole record in memory, which past 16 MiB this does not.
    assert.deepEqual(await t.run('tar -tf pkg.tar -b 32768 pkg/README.md'), result('pkg/README.md\n'))
    for (const blocks of ['32769', '2147483647']) {
      await gap(t, `tar -tf pkg.tar -b ${blocks}`, '--blocking-factor', `tar: ${blocks}: a record of that many blocks is more than this terminal holds\n`)
    }
    // A compressor other than gzip, known by its name or its first bytes.
    await gap(t, 'tar -tf fake.xz', '-J', 'tar: -J: archives compressed other than with gzip are not supported\n')
    // A tar is a tar whatever its name says.
    assert.deepEqual(await t.run('cp pkg.tar /tmp/pkg.tar.xz && tar -tf /tmp/pkg.tar.xz pkg/README.md'), result('pkg/README.md\n'))
  })
})

describe('tar extracts into the writable overlay', () => {
  it('writes every entry where -C says, as GNU writes it', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && cp /repo/pkg.tar /repo/pkg.tgz . && mkdir out && tar -xf pkg.tar -C out && find out | sort && cat out/pkg/link'), result(
      'out\nout/pkg\nout/pkg/README.md\nout/pkg/bin\nout/pkg/bin/run.sh\nout/pkg/empty\nout/pkg/link\nout/pkg/src\nout/pkg/src/index.js\nout/pkg/src/lib\nout/pkg/src/lib/numbers.txt\nout/pkg/src/lib/util.js\n# pkg\n',
      { cwd: '/tmp' },
    ))
    assert.deepEqual(await t.run('tar -xvf pkg.tar -C out pkg/src'), result('pkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n', { cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -xkf pkg.tar -C out pkg/README.md'), result('', {
      stderr: 'tar: pkg/README.md: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n', exitCode: 2, cwd: '/tmp',
    }))
    // -O writes the files to stdout, which moves the names to stderr.
    assert.deepEqual(await t.run('tar -xvOf pkg.tar pkg/src/index.js pkg/README.md'), result('# pkg\nexport const x = 1\n', { stderr: 'pkg/README.md\npkg/src/index.js\n', cwd: '/tmp' }))
    // --strip-components takes leading names off, and passes over an entry
    // it takes everything from; -v names what is stored.
    assert.deepEqual(await t.run('mkdir s && tar -xvzf pkg.tgz -C s --strip-components=2 && find s | sort'), result(
      'pkg/bin/run.sh\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\ns\ns/index.js\ns/lib\ns/lib/numbers.txt\ns/lib/util.js\ns/run.sh\n',
      { cwd: '/tmp' },
    ))
  })

  it('names at -vv each directory it made on the way to an entry', async () => {
    const t = await terminal()
    const made = (name) => `drwx------                  Creating directory: ${name}\n`
    assert.deepEqual(await t.run('cd /tmp && mkdir v && tar -xvvf /repo/pkg.tar -C v pkg/src/lib/util.js pkg/bin'), result(
      lines(LONG[2]) + made('pkg') + lines(LONG[3], LONG[10]) + made('pkg/src') + made('pkg/src/lib'),
      { cwd: '/tmp' },
    ))
    assert.deepEqual(await t.run('tar -xvvf /repo/pkg.tar -C v pkg/src/lib/util.js'), result(lines(LONG[10]), { cwd: '/tmp' }))
    // Under the name it is extracted as; --utc asks for the long listing.
    assert.deepEqual(await t.run('mkdir s && tar -xvvf /repo/pkg.tar -C s --strip-components=1 pkg/src/lib/util.js'), result(lines(LONG[10]) + made('src') + made('src/lib'), { cwd: '/tmp' }))
    assert.deepEqual(await t.run('mkdir u && tar -xf /repo/pkg.tar --utc -C u pkg/README.md'), result(lines(LONG[1]) + made('pkg'), { cwd: '/tmp' }))
  })

  it('unlinks what stands in the way, and keeps a directory that is not empty', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && mkdir -p c/pkg/README.md/x && echo old > c/pkg/link && tar -xvf /repo/pkg.tar -C c pkg/README.md pkg/link; echo $?'), result('pkg/README.md\npkg/link\n2\n', {
      stderr: 'tar: pkg/README.md: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n', cwd: '/tmp',
    }))
    // The file in the link's way is gone, and the link is what the archive says.
    assert.match((await t.run('ls -l c/pkg/link')).stdout, / c\/pkg\/link -> README\.md\n$/u)
  })

  it('enters each -C as the entries it applies to come up', async () => {
    const t = await terminal()
    const fatal = 'tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('cd /tmp && tar -xf /repo/pkg.tar -C nodir'), result('', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -tf /repo/pkg.tar -C nodir'), result('', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -xvf /repo/pkg.tar -C . pkg/README.md -C nodir pkg/link'), result('pkg/README.md\n', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.equal((await t.run('cat pkg/README.md')).stdout, '# pkg\n')
  })

  it('reports a time it cannot keep as a gap, where GNU would warn of it', async () => {
    // GNU warns of a time before 1970, or after it began, once it has written
    // the entry; the overlay keeps no times, and how far in the future one is
    // GNU counts to the nanosecond.
    const t = await terminal()
    const r = await gap(t, 'tar -xvf times.tar -C /tmp', 'archive times', 'tar: old: extracting an entry dated before 1970 or in the future is not supported\n')
    assert.equal(r.stdout, 'old\n')
    await gap(t, 'tar -xf times.tar -C /tmp future', 'archive times', 'tar: future: extracting an entry dated before 1970 or in the future is not supported\n')
    // What is not written sets no time.
    assert.deepEqual(await t.run('tar -xOf times.tar'), result('f\nf\nf\n'))
    assert.deepEqual(await t.run('tar -xf times.tar -C /tmp now'), result(''))
  })

  it('reports a write it cannot make here as a gap', async () => {
    const t = await terminal()
    // Outside /tmp is the read-only filesystem every other write meets.
    await gap(t, 'tar -xf pkg.tar', 'read-only target', 'tar: pkg: Cannot mkdir: Read-only file system\n')
    // The overlay holds no hard links and no devices.
    await gap(t, 'tar -xf sp.tar -C /tmp sp/hard', 'link', 'tar: sp/hard: extracting hard links is not supported\n')
    await gap(t, 'tar -xf sp.tar -C /tmp sp/fifo', 'fifo', 'tar: sp/fifo: extracting special files is not supported\n')
  })
})

// The tree GNU was run over for the archives below, as this terminal holds
// it: every file `-rw-------`, every directory `drwx------`, the link
// `lrwxrwxrwx`, all dated to MADE — `touch -h -d @1789710720` over the lot.
const MADE = Date.UTC(2026, 8, 18, 5, 52)
const TREE = {
  'src/a.txt': 'hello\n',
  'src/sub/b.txt': 'b\n',
  'src/big.txt': Array.from({ length: 2000 }, (_, i) => `${i + 1}\n`).join(''),
  'src/link': { type: 'link', target: 'a.txt' },
}
async function stopped(fn) {
  mock.timers.enable({ apis: ['Date'], now: MADE })
  try { return await fn() } finally { mock.timers.reset() }
}

describe('tar writes the archive GNU writes', () => {
  it('byte for byte, given the owners it has no numbers for', async () => {
    const t = await stopped(() => createTerminal(TREE, { mount: '/repo', writable: '/tmp/' }))
    // `tar --sort=name OPTIONS -cf x.tar src | sha256sum`, over that tree.
    const cases = [
      ['--owner=0 --group=0 --numeric-owner', 'e9b6fd5f774d02c2abbb4344ed0245453551377853c6e5465cf6944dafe70d01'],
      ['--owner=user:1000 --group=user:1000', '40bc83898c629725f8b04860df6064c57e8b729fe566f2714c9ee8e956f05d58'],
      ['--format=ustar --owner=0 --group=0 --numeric-owner', 'cb5daf84d306b6b3689e6c031d035d60186eac290c2cb8768a915a87282e9454'],
      ['-b 1 --owner=0 --group=0 --numeric-owner', 'd8016f50d5d43527ac9e4bab862ce5e2fe3719ca38230b88147b2d4d518ebede'],
    ]
    for (const [options, sum] of cases) {
      assert.deepEqual(await t.run(`tar -cf /tmp/x.tar ${options} src && sha256sum /tmp/x.tar`), result(`${sum}  /tmp/x.tar\n`), options)
    }
    // Through gzip, and back.
    assert.deepEqual(await t.run('tar -czf /tmp/x.tgz --owner=0 --group=0 --numeric-owner src && gzip -dc /tmp/x.tgz | sha256sum'), result(`${cases[0][1]}  -\n`))
  })

  it('stores a file it meets again as a hard link, given several operands', async () => {
    const t = await stopped(() => createTerminal(TREE, { mount: '/repo', writable: '/tmp/' }))
    await t.run('export TZ=UTC')
    const own = '--owner=0 --group=0 --numeric-owner'
    // `tar --sort=name OPTIONS -cf x.tar OPERANDS | sha256sum`, over that tree
    // in a directory named repo. --utc asks for the long listing.
    assert.deepEqual(await t.run(`tar -cf /tmp/x.tar --utc ${own} src -C src a.txt && sha256sum /tmp/x.tar`), result(lines(
      'drwx------ 0/0               0 2026-09-18 05:52 src/',
      '-rw------- 0/0               6 2026-09-18 05:52 src/a.txt',
      '-rw------- 0/0            8893 2026-09-18 05:52 src/big.txt',
      'lrwxrwxrwx 0/0               0 2026-09-18 05:52 src/link -> a.txt',
      'drwx------ 0/0               0 2026-09-18 05:52 src/sub/',
      '-rw------- 0/0               2 2026-09-18 05:52 src/sub/b.txt',
      'hrw------- 0/0               0 2026-09-18 05:52 a.txt link to src/a.txt',
      '14fa4adcf23a4fc950ab6374a6ce2bd7e80491750858991de8c10f53616fcc0f  /tmp/x.tar',
    )))
    // A link as a link; a directory it walks again, and not as a link.
    assert.deepEqual(await t.run(`tar -cvvf /tmp/x.tar ${own} src/link ../repo/src/link && sha256sum /tmp/x.tar`), result(lines(
      'lrwxrwxrwx 0/0               0 2026-09-18 05:52 src/link -> a.txt',
      'hrwxrwxrwx 0/0               0 2026-09-18 05:52 ../repo/src/link link to src/link',
      '3d24ad0f1353b7c7f78cac9bb487b925a67bab230991680e9daa04a0aba30d21  /tmp/x.tar',
    ), { stderr: "tar: Removing leading `../' from member names\n" }))
    assert.deepEqual(await t.run(`tar -cvf /tmp/x.tar ${own} src/sub/b.txt ../repo/src/sub && sha256sum /tmp/x.tar`), result(
      'src/sub/b.txt\n../repo/src/sub/\n../repo/src/sub/b.txt\n83188c1e262e5054047c45826525fb6998330df703e31625ff0e69d5f17edc03  /tmp/x.tar\n',
      { stderr: "tar: Removing leading `../' from member names\n" },
    ))
    // A name given twice is a hard link to itself, which the package will
    // not write.
    await gap(t, `tar -cf /tmp/y.tar ${own} src/a.txt src/a.txt`, 'repeated name', 'tar: src/a.txt: storing a name again, as a hard link to itself, is not supported\n')
  })

  it('refuses to make up the numbers an archive records', async () => {
    const t = await terminal(TREE)
    const message = 'tar: the files here have no numeric owner or group to record; give them with --owner=NAME:UID and --group=NAME:GID, or as ids with --numeric-owner\n'
    await gap(t, 'tar -cf /tmp/x.tar src', 'file owners', message)
    await gap(t, 'tar -cf /tmp/x.tar --owner=root --group=root src', 'file owners', message)
    await gap(t, 'tar -cf /tmp/x.tar --owner=0 --group=0 src', 'file owners', message)
    // A number GNU cannot read is its own error, before anything else.
    assert.deepEqual(await t.run('tar -cf /tmp/x.tar --owner=user:abc src'), result('', { stderr: 'tar: abc: Invalid owner or group ID\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    // A pax header carries times this tree does not have.
    await gap(t, 'tar -cf /tmp/x.tar --format=pax --owner=0 --group=0 --numeric-owner src', '--format=pax', 'tar: the pax format records access and change times, which this tree does not have\n')
  })
})

describe('tar names what it stores as GNU does', () => {
  const own = '--owner=0 --group=0 --numeric-owner'

  it('takes a leading slash or climb off, once per prefix', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf /tmp/x.tar ${own} /repo/src/a.txt ../repo/src/sub && tar -tf /tmp/x.tar`), result('/repo/src/a.txt\n../repo/src/sub/\n../repo/src/sub/b.txt\nrepo/src/a.txt\nrepo/src/sub/\nrepo/src/sub/b.txt\n', {
      stderr: "tar: Removing leading `/' from member names\ntar: Removing leading `/' from hard link targets\ntar: Removing leading `../' from member names\ntar: Removing leading `../' from hard link targets\n",
    }))
  })

  it('reports what it could not find, and goes on', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cf /tmp/x.tar ${own} src/a.txt missing src/link; tar -tf /tmp/x.tar`), result('src/a.txt\nsrc/link\n', {
      stderr: 'tar: missing: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n',
    }))
  })

  it('moves operands with -C, and says so of one that moves nothing', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf /tmp/x.tar ${own} -C src a.txt -C sub b.txt -C /tmp`), result('a.txt\nb.txt\n', {
      stderr: 'tar: The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.\n'
        + "tar: -C ‘/tmp’ has no effect\ntar: Exiting with failure status due to previous errors\n",
      exitCode: 2,
    }))
    // A -C it cannot enter ends the run, and leaves the archive with only
    // the whole records it had written: none, here.
    assert.deepEqual(await t.run(`tar -cf /tmp/y.tar ${own} src/a.txt -C nodir x; wc -c < /tmp/y.tar`), result('0\n', {
      stderr: 'tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n',
    }))
  })

  it('leaves the archive itself out of what it walks', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`mkdir /tmp/w && echo x > /tmp/w/f && tar -cf /tmp/w/self.tar ${own} /tmp/w && tar -tf /tmp/w/self.tar`), result('tmp/w/\ntmp/w/f\n', {
      stderr: "tar: Removing leading `/' from member names\ntar: /tmp/w/self.tar: archive cannot contain itself; not dumped\n",
    }))
  })

  it('writes to stdout, and lists on stderr when it does', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf - ${own} src/sub | tar -t`), result('src/sub/\nsrc/sub/b.txt\n', { stderr: 'src/sub/\nsrc/sub/b.txt\n' }))
    // So does -O, which writes nothing there.
    assert.deepEqual(await t.run(`tar -cvOf /tmp/o.tar ${own} src/sub`), result('', { stderr: 'src/sub/\nsrc/sub/b.txt\n' }))
    // -a picks gzip by the name.
    assert.deepEqual(await t.run(`tar -caf /tmp/a.tgz ${own} src/a.txt && tar -tzf /tmp/a.tgz`), result('src/a.txt\n'))
  })

  it('refuses a name the package would store differently', async () => {
    const t = await terminal(TREE)
    // GNU stores `./a.txt`; the package would store `a.txt`.
    await gap(t, `tar -cf /tmp/x.tar ${own} -C src .`, 'dot-segment names', "tar: ./a.txt: member names with `.' or empty segments are not supported\n")
  })
})
