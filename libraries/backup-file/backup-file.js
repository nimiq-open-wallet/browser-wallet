import Iqons from '../iqons/dist/iqons.min.js';
import QrEncoder from '../qr-encoder/qr-encoder.min.js';
export default class WalletBackup {

    static get PHI() { return 1.618 }
    static get WIDTH() { return 300 * this.PHI }
    static get HEIGHT() { return this.WIDTH * this.PHI }
    static get IDENTICON_SIZE() { return this.WIDTH / this.PHI }
    static get QR_SIZE() { return this.WIDTH * (1 - 1 / this.PHI) }
    static get PADDING() { return 8 }

    constructor(address, encodedPrivKey) {
        this._width = WalletBackup.WIDTH;
        this._height = WalletBackup.HEIGHT;
        const $canvas = document.createElement('canvas');
        $canvas.width = this._width;
        $canvas.height = this._height;
        this.$canvas = $canvas;
        this._address = address;
        this._ctx = $canvas.getContext('2d');
        this._drawPromise = this._draw(address, encodedPrivKey);
    }

    static calculateQrPosition(walletBackupWidth = WalletBackup.WIDTH, walletBackupHeight = WalletBackup.HEIGHT) {
        const size = WalletBackup.QR_SIZE;
        const padding = WalletBackup.PADDING * 1.5;

        let x = (walletBackupWidth - size) / 2;
        let y = (walletBackupHeight + walletBackupHeight / WalletBackup.PHI) / 2 - size / 2;
        x += padding / 2; /* add half padding to cut away the rounded corners */
        y += padding / 2;

        const width = size - padding;
        const height = size - padding;
        return { x, y, size, padding, width, height };
    }

    filename() {
        return this._address.replace(/ /g, '-') + '.png';
    }

    async toDataUrl() {
        await this._drawPromise;
        return this.$canvas.toDataURL().replace(/#/g, '%23');
    }

    async toObjectUrl() {
        await this._drawPromise;
        return this._toObjectUrl();
    }

    _toObjectUrl() {
        return new Promise(resolve => {
            this.$canvas.toBlob(blob => {
                const url = URL.createObjectURL(blob);
                resolve(url);
            });
        })
    }

    _draw(address, encodedPrivKey) {
        this._drawBackgroundGradient();
        this._drawEncodedPrivKey(encodedPrivKey);

        this._setFont();
        this._drawAddress(address);
        this._drawHeader();

        return this._drawIdenticon(address);
    }

    async _drawIdenticon(address) {
        const $img = await Iqons.image(address);
        const size = WalletBackup.IDENTICON_SIZE;
        const pad = (this._width - size) / 2;
        const x = pad;
        const y = this._height - this._width - size / 2;
        this._ctx.drawImage($img, x, y, size, size);
    }

    _setFont() {
        const ctx = this._ctx;
        ctx.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
    }

    _drawHeader() {
        const ctx = this._ctx;
        const x = this._width / 2;
        const y = WalletBackup.PADDING * 6;
        ctx.font = '500 20px ' + ctx.fontFamily;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('ACCOUNT ACCESS FILE', x, y);

        ctx.font = '500 16px ' + ctx.fontFamily;
        ctx.fillText('DO NOT share this File or QR Code!', x, WalletBackup.PADDING * 12.5);
    }

    _drawAddress(address) {
        const ctx = this._ctx;
        const qrSize = WalletBackup.QR_SIZE;
        const x = this._width / 2;
        const y = this._width;
        ctx.font = '500 16px ' + ctx.fontFamily;
        ctx.fillStyle = 'white';
        ctx.fillText(address, x, y);
    }

    _drawEncodedPrivKey(encodedPrivKey) {
        const $el = document.createElement('div');
        QrEncoder.render({
            text: encodedPrivKey,
            radius: 0.8,
            ecLevel: 'Q',
            fill: '#2e0038',
            background: 'transparent',
            size: Math.min(240, (window.innerWidth - 64))
        }, $el);

        const $canvas = $el.querySelector('canvas');
        const qrPosition = WalletBackup.calculateQrPosition(this._width, this._height);

        this._ctx.fillStyle = 'white';
        this._ctx.strokeStyle = 'white';
        this._roundRect(qrPosition.x, qrPosition.y, qrPosition.size, qrPosition.size, 16, true);

        const padding = qrPosition.padding;
        this._ctx.drawImage($canvas, qrPosition.x + padding, qrPosition.y + padding, qrPosition.size - 2 * padding,
            qrPosition.size - 2 * padding);
    }

    _drawBackgroundGradient() {
        this._ctx.fillStyle = 'white';
        this._ctx.fillRect(0, 0, this._width, this._height);
        const gradient = this._ctx.createLinearGradient(0, 0, 0, this._height);
        gradient.addColorStop(0, '#536DFE');
        gradient.addColorStop(1, '#a553fe');
        this._ctx.fillStyle = gradient;
        this._ctx.strokeStyle = 'transparent';
        this._roundRect(0, 0, this._width, this._height, 16, true);
    }

    _roundRect(x, y, width, height, radius, fill, stroke) {
        const ctx = this._ctx;
        if (typeof stroke === 'undefined') {
            stroke = true;
        }
        if (typeof radius === 'undefined') {
            radius = 5;
        }
        if (typeof radius === 'number') {
            radius = { tl: radius, tr: radius, br: radius, bl: radius };
        } else {
            var defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 };
            for (var side in defaultRadius) {
                radius[side] = radius[side] || defaultRadius[side];
            }
        }
        ctx.beginPath();
        ctx.moveTo(x + radius.tl, y);
        ctx.lineTo(x + width - radius.tr, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
        ctx.lineTo(x + width, y + height - radius.br);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
        ctx.lineTo(x + radius.bl, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
        ctx.lineTo(x, y + radius.tl);
        ctx.quadraticCurveTo(x, y, x + radius.tl, y);
        ctx.closePath();
        if (fill) {
            ctx.fill();
        }
        if (stroke) {
            ctx.stroke();
        }
    }
}
