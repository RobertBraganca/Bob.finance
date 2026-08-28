# 0001. Local-first com SQLite, sem backend em nuvem

Status: aceita

## Contexto
O produto guarda extratos bancários completos, dívida e posição de
investimento de uma pessoa. Qualquer backend em nuvem, mesmo com boas
práticas, adiciona superfície de risco (conta comprometida, provedor
vazando dado, custo recorrente) para um caso de uso de um usuário só.

## Decisão
O app roda inteiramente na máquina do usuário. Os dados vivem num único
arquivo SQLite (`data/finance.db`), lido por `better-sqlite3`. Não há login,
não há sincronização, não há chamada de rede além da cotação BRAPI (opcional,
sob chave própria do usuário).

## Alternativas consideradas
- **Postgres + backend hospedado:** motor mais robusto para concorrência,
  mas exige autenticação, hospedagem e superfície de ataque que este caso de
  uso não justifica.
- **IndexedDB no navegador:** eliminaria até o servidor local, mas perde
  SQL relacional real (agregações do dashboard dependem de `JOIN`s e `GROUP
  BY` pesados) e amarra o dado ao navegador, não à máquina.

## Consequências
- Sem multiusuário real hoje (ver PRD, seção 8) — aceito de propósito.
- Migração futura para Postgres é viável sem reescrever agregação, porque o
  schema é relacional e desenhado sem função específica do SQLite (ver
  `architecture.md`).
- Backup é responsabilidade do usuário copiar o arquivo; não há
  redundância automática.
