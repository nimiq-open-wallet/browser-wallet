# Nimiq Open Wallet (Beta)

## Installation
You will need [NodeJS](https://nodejs.org/en/). Also install `live-server` and `live-server-https` as follows:
```
sudo npm install -g live-server
sudo npm install -g live-server-https
```

Clone this repo:
```
git clone https://github.com/nimiq-open-wallet/nimiq-open-wallet.github.io
```

Next move into the directory and start the web server:
```
cd nimiq-open-wallet.github.io
live-server --https=/usr/lib/node_modules/live-server-https
```

You can now access the wallet at https://127.0.0.1:8080/safe/.
