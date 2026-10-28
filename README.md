# Light Studio's — versão Netlify

## Como colocar no ar (grátis)

1. Crie uma conta em https://app.netlify.com e um repositório no GitHub com **esta pasta inteira**
   (ou use o Netlify CLI: `npm i -g netlify-cli`, depois `netlify deploy --prod`).
2. No Netlify: **Add new site → Import an existing project** → escolha o repositório.
   As configurações já vêm do `netlify.toml` (nada pra preencher).
3. **Antes de abrir o site**: Site configuration → Environment variables → **Add a variable**
   - Chave: `ADMIN_PASSWORD`   Valor: a senha que você quiser (use uma forte)
   Depois faça um novo deploy (Deploys → Trigger deploy) para a variável valer.
4. Abra o site, clique em **admin** no rodapé e entre com a senha.

## Testar no seu PC
    npm install
    npx netlify dev
(crie um arquivo `.env` com `ADMIN_PASSWORD=minhasenha` na pasta)

## Limites importantes
- Upload direto (banner, capas e arquivo de jogo): **até 4 MB** (limite das Netlify Functions).
- Jogos grandes: hospede em outro lugar (GitHub Releases, Google Drive, Mega) e use o botão
  **"Colar link de download"** — o visitante clica em Baixar no seu site e é levado ao arquivo.
- Os textos, imagens e links ficam no Netlify Blobs (não somem a cada deploy).
