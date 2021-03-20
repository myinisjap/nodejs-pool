FROM ubuntu:18.04 as build

RUN apt-get update && apt-get install -y curl
RUN cd /tmp && curl -L https://downloads.getmonero.org/cli/monero-linux-x64-v0.17.1.6.tar.bz2 -o monero.tar.gz && \
  cd /tmp && mkdir /monero && tar -xjf monero.tar.gz -C /monero && cd /monero && mv monero-x86_64-linux-gnu-v0.17.1.6/* .

FROM ubuntu:16.04
COPY --from=build /monero/monero-wallet-rpc /monero/monero-wallet-rpc

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade

RUN DEBIAN_FRONTEND=noninteractive apt-get -y install git curl python-virtualenv python3-virtualenv \
  build-essential libzmq3-dev libboost-all-dev sudo mysql-server && \
  rm -rf /var/lib/apt/lists/*


RUN useradd -ms /bin/bash pool
ENV CURUSER=pool
ENV POOL_DIR=/home/pool
ENV PATH=${PATH}:/home/pool/.nodejs/bin:/home/pool/.bin
RUN mkdir $POOL_DIR/.bin &&\
    cd $POOL_DIR/.bin &&\
    curl -Lo ./wait-util https://github.com/ufoscout/docker-compose-wait/releases/download/2.7.3/wait &&\
    chmod +x ./wait-util

RUN WORKDIR=$(mktemp -d) &&\
    curl -o$WORKDIR/node.tar.gz  https://nodejs.org/dist/latest-v8.x/node-v8.17.0-linux-x64.tar.gz &&\
    cd $WORKDIR &&\
    tar -xf node.tar.gz &&\
    mv node-v8.17.0-linux-x64/ $POOL_DIR/.nodejs/

COPY package*.json /home/pool/pool/
RUN chown -R pool /home/pool/

USER pool
RUN mkdir -p $POOL_DIR/pool_db/ $POOL_DIR/keys &&\
    cd $POOL_DIR/pool &&\
    npm install --production &&\
    npm install -g pm2 &&\
    openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500 &&\
    pm2 install pm2-logrotate

#    INSTALL LMDB TOOLS
RUN cd ~ &&\
    git clone https://github.com/LMDB/lmdb &&\
    cd lmdb &&\
    git checkout 4d2154397afd90ca519bfa102b2aad515159bd50 &&\
    cd libraries/liblmdb/ &&\
    make -j `nproc` &&\
    mkdir -p ~/.bin &&\
    echo ' ' >> ~/.bashrc &&\
    echo 'export PATH=~/.bin:$PATH' >> ~/.bashrc &&\
    for i in mdb_copy mdb_dump mdb_load mdb_stat; do cp $i ~/.bin/; done

COPY deployment/docker/backend/start.bash /home/pool/start.bash
COPY deployment/docker/backend/stack.yml /home/pool/stack.yml
USER root
COPY . /home/pool/pool
RUN chown -R pool /home/pool/pool

USER pool
WORKDIR /home/pool

ARG DB_STORAGE_PATH
ARG DB_HOST
ARG DB_NAME
ARG DB_USER
ARG DB_PASS

ENTRYPOINT /home/pool/start.bash