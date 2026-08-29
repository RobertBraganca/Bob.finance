# 0033. Login via Supabase Auth, usuário único (admin)

Status: aceita

## Contexto
A revisão de 28/08/2026 registrou como risco aceito, não como decisão
definitiva: "sem autenticação nenhuma; a anon key pública é o único portão
de qualquer Edge Function... risco real se a anon key vazar e a URL for
descoberta — aceitável hoje, não defendido contra ator visado." Em
29/08/2026 o usuário criou manualmente um usuário no Supabase Auth
(`robert.s.braganca@gmail.com`, provider Email) e pediu login real,
protegendo as rotas do app, com esse usuário como o único admin — todos os
dados atuais (o ledger real de uma pessoa só) pertencem a ele.

## Decisão
- **Frontend**: `@supabase/supabase-js` + uma tela de login
  (`src/pages/Login.tsx`, `src/lib/auth.tsx`) — sem fluxo de cadastro (o
  único jeito de existir uma conta é o admin criar direto no painel do
  Supabase). `App.tsx` não renderiza nenhuma rota do app sem sessão válida.
  `src/lib/authToken.ts` é a ponte pro token de acesso chegar em `api.ts`
  (módulo puro, não pode chamar `useAuth()`), mesmo padrão já usado por
  `toastBus.ts`.
- **Backend**: `supabase/functions/_shared/auth.ts` — middleware Hono
  (`requireAdmin`) aplicado nas três Edge Functions que expõem dado real
  (`pricing`, `insights`, `ledger`). Verifica o JWT do header
  `Authorization` contra o servidor de Auth do Supabase (`getUser(token)`,
  não só decodificação local) e exige que o `user.id` bata com
  `ADMIN_USER_ID` (constante fixa no código, não secret — um UID sozinho
  não concede acesso, quem concede é a senha verificada pelo Supabase Auth
  antes de chegar aqui). `telemetry` foi deixada de fora deliberadamente —
  só registra eventos de uso, nunca dado financeiro, e é o próprio
  mecanismo que também loga erro/vazio de uma tela ainda sem sessão.
- **Sem multi-tenant.** Nenhuma tabela ganhou coluna `user_id` — este app
  continua "de uma pessoa só" (ver `docs/PRD.md`, `docs/architecture.md`).
  `ADMIN_USER_ID` é uma lista de permissão de um usuário, não um modelo de
  dado por usuário. Se um segundo usuário algum dia precisar existir, isso
  é um redesenho de dados à parte, não uma extensão deste ADR.

## Alternativas consideradas
- **RLS por usuário no Postgres**: descartada por ora — o app conecta no
  banco direto via `postgres-js`/`drizzle-orm`, não via PostgREST, então
  policy de RLS não intercepta essas queries de qualquer forma (mesmo
  achado já registrado na revisão de 28/08/2026: "RLS decorativa"). Fazer
  RLS valer de verdade exigiria trocar o driver de acesso ao banco — fora
  de escopo deste pedido, que era "proteger as rotas".
- **Middleware verificando só a assinatura do JWT localmente** (sem round
  trip a `getUser`): mais rápido, mas decodificar sem checar revogação
  contra o servidor de Auth é uma verificação mais fraca — para uma API
  financeira, a chamada extra de rede por requisição é um custo aceitável.

## Consequências
- **Toda chamada às três Edge Functions protegidas agora exige sessão** —
  a anon key sozinha não basta mais. Isso quebra o build de produção já
  publicado no Vercel até o frontend novo (com login) ser publicado junto
  — as duas metades desta mudança precisam subir na mesma janela.
- Cadastro público de conta continua tecnicamente possível direto pela API
  do Supabase Auth (o app não expõe uma tela para isso, mas a plataforma
  permite por padrão) — `requireAdmin` já bloqueia qualquer UID que não
  seja o admin, então isso não é uma brecha de acesso a dado, só ruído.
  Desligar "Allow new users to sign up" no painel do Supabase (Authentication
  → Providers → Email) fecha isso também; não foi automatizado aqui porque
  a única forma seguura encontrada (`supabase config push`) enviaria o
  `config.toml` inteiro (com `site_url` de localhost, nunca adaptado para
  produção) para o projeto real — risco maior que o benefício.
- `server/src/routes/*` (Fastify, dev-only) não ganhou este middleware —
  nunca teve rota exposta em produção, e continua não tendo.
- Verificado ao vivo contra o projeto real: as três funções devolvem 401
  sem `Authorization`, e 401 com um token inválido — não foi possível
  testar o caminho de sucesso (login de verdade) nesta sessão por não ter
  a senha do usuário; o próprio usuário precisa confirmar esse caminho.
