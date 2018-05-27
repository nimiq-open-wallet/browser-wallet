var Base64 = {
    _keyStr: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;:=',
    encode: function(e) {
        var t = '';
        var n, r, i, s, o, u, a;
        var f = 0;
        while (f < e.length) {
            n = e[f++] & 0xFF;
            r = e[f++] & 0xFF;
            i = e[f++] & 0xFF;
            s = n >> 2;
            o = (n & 3) << 4 | r >> 4;
            u = (r & 15) << 2 | i >> 6;
            a = i & 63;
            if (isNaN(r)) {
                u = a = 64
            } else if (isNaN(i)) {
                a = 64
            }
            t = t + this._keyStr.charAt(s) + this._keyStr.charAt(o) + this._keyStr.charAt(u) + this._keyStr.charAt(a)
        }
        return t;
    },
    decode: function(e) {
        var t = [];
        var n, r, i;
        var s, o, u, a;
        var f = 0;
        e = e.replace(/[^A-Za-z0-9;:=]/g, ''); // should remove those characters not included in _keyStr
        while (f < e.length) {
            s = this._keyStr.indexOf(e.charAt(f++));
            o = this._keyStr.indexOf(e.charAt(f++));
            u = this._keyStr.indexOf(e.charAt(f++));
            a = this._keyStr.indexOf(e.charAt(f++));
            n = s << 2 | o >> 4;
            r = (o & 15) << 4 | u >> 2;
            i = (u & 3) << 6 | a;
            t.push(n);
            if (u != 64) {
                t.push(r)
            }
            if (a != 64) {
                t.push(i)
            }
        }
        return t
    }  
}
