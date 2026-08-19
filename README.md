# CS2 Combo Tracker — ONLINE v5

Inclui login privado, Dashboard CS2, Tracking individual, auto-refresh a cada 10 minutos e persistência SQLite num Railway Volume.

## Railway variables
APP_USER=pedro
APP_PASSWORD=<A_TUA_PASSWORD>
SESSION_SECRET=4kc_MsfJCofi1HCojAHnaBeQuBnyPRq_w3Xa3fdtafw
DATA_DIR=/data

## Volume
Monta um Railway Volume em `/data`.

## Start command
npm start


## v6 OPTIMIZED — Database size

A v6 corrige a principal causa do crescimento excessivo da SQLite:

- O Dashboard já não guarda todas as Combo Positions de cada wallet.
- Só são persistidas positions cuja Combo contenha pelo menos uma leg de um jogo CS2 ativo.
- O tracking individual continua a persistir apenas Combos que correspondem ao jogo seguido.
- É feita limpeza automática de Combos/positions irrelevantes.
- SQLite usa journal_mode=DELETE em vez de WAL para reduzir ficheiros temporários no Railway Volume.
- O painel lateral mostra agora o tamanho aproximado do ficheiro SQLite.

### IMPORTANTE AO MIGRAR DA v5
A BD antiga já cresceu até perto do limite de 500 MB. DELETE em SQLite não reduz automaticamente
um ficheiro já inflado. Depois de fazer deploy da v6, faz UM ÚNICO "Wipe volume" no Railway para
começar com uma SQLite nova e otimizada. Não voltes a fazer wipe depois disso, salvo necessidade.
