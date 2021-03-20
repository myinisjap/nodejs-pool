FROM node:8 as build

COPY poolui/package*.json ./
RUN npm install
COPY ./poolui .

RUN  sed -i 's@hostname@'$WEB_HOSTNAME'@' app/globals.js
RUN npx bower update --allow-root
RUN npx gulp build

FROM nginx:1.19.5

COPY --from=build /build /www