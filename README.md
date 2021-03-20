Pool Design/Theory
==================
The nodejs-pool is built around a small series of core daemons that share access to a single LMDB table for tracking of shares, with MySQL being used to centralize configurations and ensure simple access from local/remote nodes.  The core daemons follow:
```text
api - Main API for the frontend to use and pull data from.  Expects to be hosted at  /
remoteShare - Main API for consuming shares from remote/local pools.  Expects to be hosted at /leafApi
pool - Where the miners connect to.
longRunner - Database share cleanup.
payments - Handles all payments to workers.
blockManager - Unlocks blocks and distributes payments into MySQL
worker - Does regular processing of statistics and sends status e-mails for non-active miners.
walletRpc - Runs Monero RPC to retrieve data
```
API listens on port 8001, remoteShare listens on 8000

Xmrpool.net (The reference implementation) uses the following setup:  
* https://xmrpool.net is hosted on its own server, as the main website is a static frontend
* https://api.xmrpool.net hosts api, remoteShare, longRunner, payments, blockManager, worker, as these must all be hosted with access to the same LMDB database.

The Dockerized version kicks off 5 docker containers and keeps 4 running
```text
monerod - the monero daemon itself
monerod-init - used to make sure the files are owned by user monero (this one does not stay running)
pool-web - the web front end serves the directory "deployment/docker/web/poolui"
pool-backend - this is what does all the heavy lifting (api,remoteShare,pool,longRunner,payments,blockManager,worker,walletRpc)
db - mysql 5.7 
```


Setup Instructions
==================

Server Requirements
-------------------
* 4 Gb Ram
* 2 CPU Cores (with AES_NI)
* 100 Gb SSD-Backed Storage - The pool comes configured to use up to 24Gb of storage for LMDB.  Assuming you have the longRunner worker running, it should never get near this size, but be aware that it /can/ bloat readily if things error, so be ready for this!
* Docker installed

Pre-Deploy
----------
* If you're planning on using e-mail, you will want to setup an account at https://mailgun.com (It's free for 10k e-mails/month!), so you can notify miners.  This also serves as the backend for password reset emails, along with other sorts of e-mails from the pool, including pool startup, pool Monerod daemon lags, etc so it's highly suggested!
* Pre-Generate the wallet(s) you'll need the addresses before and after the install is complete, so I'd suggest making sure you have them available.  Information on suggested setups are found below.
* If you're going to be offering PPS, PLEASE make sure you load the pool wallet with XMR before you get too far along.  Your pool will trigger PPS payments on its own, and fairly readily, so you need some float in there!

Wallet Setup
------------
The pool is designed to have a dual-wallet design, one which is a fee wallet, one which is the live pool wallet.  The fee wallet is the default target for all fees owed to the pool owner.

#### For the live wallet:
1. Generate your wallet using `/usr/local/src/monero/build/release/bin/monero-wallet-cli` with the name of wallet
2. Make sure to save your regeneration stuff!
3. For the pool wallet, store the password in a file and put it in `nodejs-pool/deployment/docker/backend/wallet_pass`
4. For the wallet file put it in `nodejs-pool/deployment/docker/backend/wallet`

Deployment
------------------------
1. Clone this repo
2. `cd nodejs-pool`
3. Edit the docker-compose file changing `- WEB_HOSTNAME={servername}` and `- HOSTNAME={servername}`
4. Add wallet files into file structure according to the section above
5. To start the pool run `sudo docker-compose up -d` -d is to run it as a daemon in the background
6. Hop into the web interface (Should be at `http://<your server IP>/admin.html`), then login with `Administrator/Password123`, **MAKE SURE TO CHANGE THIS PASSWORD ONCE YOU LOGIN**.
7. From the admin panel, you can configure all of your pool's settings for addresses, payment thresholds, etc.
   You should take a look at the [wiki](https://github.com/Snipa22/nodejs-pool/wiki/Configuration-Details) for specific configuration settings in the system.

Assumptions for the installer
-----------------------------
The pool comes pre-configured with values for Monero (XMR), these may need to be changed depending on the exact requirements of your coin.  Other coins will likely be added down the road, and most likely will have configuration.sqls provided to overwrite the base configurations for their needs, but can be configured within the frontend as well.


Pool Update Procedures
======================
If upgrading the pool, please do a git pull to get the latest code within the pool's directory.

Once complete, please `cd` into `sql_sync`, then run `node sql_sync.js`

This will update your pool with the latest config options with any defaults that the pools may set.

Pool Troubleshooting
====================

API stopped updating!
---------------------
This is likely due to LMDB's MDB_SIZE being hit, or due to LMDB locking up due to a reader staying open too long, possibly due to a software crash.
The first step is to run:
```shell
sudo docker ps
```
Get the id of pool-backend
```shell
sudo docker exec -it {pool-backend id} bash
```
This will give you a bash prompt in the docker
```shell
mdb_stat -fear ~/pool_db/
```
This should give you output like:
```text
Environment Info
  Map address: (nil)
  Map size: 51539607552
  Page size: 4096
  Max pages: 12582912
  Number of pages used: 12582904
  Last transaction ID: 74988258
  Max readers: 512
  Number of readers used: 24
Reader Table Status
    pid     thread     txnid
     25763 7f4f0937b740 74988258
Freelist Status
  Tree depth: 3
  Branch pages: 135
  Leaf pages: 29917
  Overflow pages: 35
  Entries: 591284
  Free pages: 12234698
Status of Main DB
  Tree depth: 1
  Branch pages: 0
  Leaf pages: 1
  Overflow pages: 0
  Entries: 3
Status of blocks
  Tree depth: 1
  Branch pages: 0
  Leaf pages: 1
  Overflow pages: 0
  Entries: 23
Status of cache
  Tree depth: 3
  Branch pages: 16
  Leaf pages: 178
  Overflow pages: 2013
  Entries: 556
Status of shares
  Tree depth: 2
  Branch pages: 1
  Leaf pages: 31
  Overflow pages: 0
  Entries: 4379344
```
The important thing to verify here is that the "Number of pages used" value is less than the "Max Pages" value, and that there are "Free pages" under "Freelist Status".  If this is the case, them look at the "Reader Table Status" and look for the PID listed.  Run:
```shell
ps fuax | grep <THE PID FROM ABOVE>

ex:
ps fuax | grep 25763
```
If the output is not blank, then one of your node processes is reading, this is fine.  If there is no output given on one of them, then proceed forwards.

The second step is to run:
```shell
pm2 stop blockManager worker payments remoteShare longRunner api
pm2 start blockManager worker payments remoteShare longRunner api
```
This will restart all of your related daemons, and will clear any open reader connections, allowing LMDB to get back to a normal state.

If on the other hand, you have no "Free pages" and your Pages used is equal to the Max Pages, then you've run out of disk space for LMDB.  You need to verify the cleaner is working.  For reference, 4.3 million shares are stored within approximately 2-3 Gb of space, so if you're vastly exceeding this, then your cleaner (longRunner) is likely broken.


PPS Fee Thoughts
================
If you're considering PPS, I've spoken with [Fireice_UK](https://github.com/fireice-uk/) whom kindly did some math about what you're looking at in terms of requirements to run a PPS pool without it self-imploding under particular risk factors, based on the work found [here](https://arxiv.org/pdf/1112.4980.pdf)

```text
Also I calculated the amount of XMR needed to for a PPS pool to stay afloat. Perhaps you should put them up in the README to stop some spectacular clusterfucks :D:
For 1 in 1000000 chance that the pool will go bankrupt: 5% fee -> 1200 2% fee -> 3000
For 1 in 1000000000 chance: 5% fee -> 1800 2% fee -> 4500
```

The developers of the pool have not verified this, but based on our own usage on https://xmrpool.net/ this seems rather reasonable.  You should be wary if you're considering PPS and take you fees into account appropriately!

Installation/Configuration Assistance
=====================================
### This is being left in as way to support the original developers but DO NOT expect help for this dockerized version from them
If you need help installing the pool from scratch, please have your servers ready, which would be Ubuntu 16.04 servers, blank and clean, DNS records pointed.  These need to be x86_64 boxes with AES-NI Available.

Installation assistance is 7 XMR, with a 3 XMR deposit, with the remainder to be paid on completion.  
Configuration assistance is 4 XMR with a 2 XMR deposit, and includes debugging your pool configurations, ensuring that everything is running, and tuning for your uses/needs.  

SSH access with a sudo-enabled user will be needed, preferably the user that is slated to run the pool.

If you'd like assistance with setting up node-cryptonote-pool, please provide what branch/repo you'd like to work from, as there's a variety of these.

Assistance is not available for frontend customization at this time.

For assistance, please contact Snipa at pool_install@snipanet.com or via IRC at irc.freenode.net in the #monero-pools channel.

Developer Donations
===================
If you'd like to make a one time donation, the addresses are as follows:
* XMR - 44Ldv5GQQhP7K7t3ZBdZjkPA7Kg7dhHwk3ZM3RJqxxrecENSFx27Vq14NAMAd2HBvwEPUVVvydPRLcC69JCZDHLT2X5a4gr
* BTC - 114DGE2jmPb5CP2RGKZn6u6xtccHhZGFmM
* AEON - WmtvM6SoYya4qzkoPB4wX7FACWcXyFPWAYzfz7CADECgKyBemAeb3dVb3QomHjRWwGS3VYzMJAnBXfUx5CfGLFZd1U7ssdXTu

Credits
=======

[Zone117x](https://github.com/zone117x) - Original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) from which, the stratum implementation has been borrowed.

[Mesh00](https://github.com/mesh0000) - Frontend build in Angular JS [XMRPoolUI](https://github.com/mesh0000/poolui)

[Wolf0](https://github.com/wolf9466/)/[OhGodAGirl](https://github.com/ohgodagirl) - Rebuild of node-multi-hashing with AES-NI [node-multi-hashing](https://github.com/Snipa22/node-multi-hashing-aesni)

[tari-project](https://github.com/tari-project) - dockerized version that I refined further