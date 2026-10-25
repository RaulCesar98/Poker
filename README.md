# ♠ Poker Texas Hold'em Online

Texas Hold'em No-Limit multiplayer em tempo real, para até **8 jogadores por mesa**, feito com Node.js + Socket.IO.

## Recursos

- **Regras completas**: dealer, small/big blind (inclusive heads-up), pré-flop, flop, turn, river e showdown
- **Sistema de fichas**: apostas, pagar, aumentar (com aumento mínimo), all-in, **side pots** (potes paralelos), pote dividido em empates, recompra quando zerar
- **Avaliador de mãos**: Carta Alta até Royal Flush, com desempate por kickers
- **Animações**: distribuição das cartas saindo do centro, flop/turn/river virando, fichas voando até a aposta e para o pote, pote indo para o vencedor, botão do dealer deslizando, cartas da mão vencedora destacadas, banner de vitória e confete
- **Sons** (sintetizados no navegador, sem arquivos): embaralhar, carta, virar carta, fichas, check (batidinha na mesa), fold, all-in, sua vez, relógio nos últimos 5 segundos, vitória e derrota. Botão 🔊 para ligar/desligar
- **Relógio por jogada** (padrão 25 s): ao estourar dá check ou fold automático; após 3 estouros o jogador fica "ausente"
- **Salas**: crie quantas quiser (nome livre), configure blinds, fichas iniciais e tempo. Link de convite com `?sala=nome`
- **Reconexão**: se cair a internet ou recarregar a página, volta para o mesmo lugar (60 s de tolerância)
- Espectadores, chat, histórico da mão, atalhos de teclado (**F** fold, **C** check/pagar, **R** aumentar) e layout para celular

## Rodar no seu computador

Precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm start
```

Abra http://localhost:3000. Para testar sozinho, abra várias abas (cada aba é um jogador).

Testes da lógica (avaliador de mãos, side pots e milhares de mãos simuladas verificando que nenhuma ficha some):

```bash
npm test
```

## Publicar no Render

1. Crie um repositório no GitHub e envie esta pasta:
   ```bash
   git init
   git add .
   git commit -m "Poker Texas Hold'em"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/poker.git
   git push -u origin main
   ```
2. No [Render](https://dashboard.render.com), clique em **New → Blueprint** e escolha o repositório — o arquivo `render.yaml` já configura tudo.
   *Ou* **New → Web Service** com:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Aguarde o deploy e compartilhe o endereço `https://SEU-APP.onrender.com/?sala=principal` com os amigos.

> **Observações sobre o plano gratuito do Render:** o serviço "dorme" após ~15 min sem acesso e leva alguns segundos para acordar no primeiro acesso. As mesas ficam na memória do servidor, então um reinício (deploy novo ou o servidor dormir) zera as fichas. Rode só **1 instância** (não escale horizontalmente), pois o estado das mesas não é compartilhado entre instâncias.

## Estrutura

```
server.js          servidor HTTP + Socket.IO, salas
src/game.js        regras da mesa (blinds, rodadas de aposta, side pots, showdown, timer)
src/hand.js        avaliador de mãos
public/index.html  interface
public/css/        estilos e animações da mesa
public/js/app.js   cliente: renderização, animações, controles
public/js/sound.js efeitos sonoros (Web Audio API)
test/sim.js        testes automatizados
render.yaml        configuração do Render
```

As fichas são de brincadeira (sem dinheiro real).
