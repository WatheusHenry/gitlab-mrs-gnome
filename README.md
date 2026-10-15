# GitLab MRs — extensão para o GNOME Shell

Seus merge requests abertos e os que aguardam sua revisão, direto na barra superior do GNOME.

## O que ela faz

- **Lista dos seus MRs** agrupada por projeto, com busca (título, projeto, branch, autor) e filtros: Prontos, Pipeline falhou, Conflito, Threads abertas, Draft e Para revisar.
- **Status de cada MR num ícone**: draft, pipeline falhou, conflito, threads abertas, pipeline rodando, pipeline aguardando, pronto para merge. Passe o mouse no ícone para ver a explicação: quais jobs falharam, quantas aprovações faltam, se há conflito com a branch de destino etc.
- **Aprovações** (✓ / ✓✓) e número de comentários em cada MR; ao passar o mouse, um botão para copiar o link.
- **Projetos reordenáveis** (arraste o cabeçalho, ou Alt+↑/↓) e recolhíveis.
- **Notificações** com botões “Abrir MR” / “Abrir pipeline”: pipeline falhou ou passou, MR aprovado, novo comentário ou thread, conflito, MR mergeado ou fechado e novo MR para revisar.
- **Ícone da barra com estado**: vermelho se alguma pipeline sua falhou, azul enquanto alguma roda, e um ponto quando chega MR novo para revisar.
- **Tela de configurações** dentro do próprio popup (URL do GitLab, token, intervalo de atualização, notificações).
- Clique na sua foto para abrir seus MRs no navegador.

## Requisitos

- GNOME Shell **42** (Ubuntu 22.04). Outras versões não foram testadas; a partir do GNOME 45 as extensões usam outro formato e esta não carrega.
- Uma conta no GitLab (gitlab.com ou instância própria) e um **Personal Access Token** com o escopo **`read_api`**.
  Crie em *GitLab → Preferences → Access Tokens*.

## Instalação

### Pelo repositório

```bash
git clone https://github.com/SEU_USUARIO/gitlab-mrs-gnome.git
cd gitlab-mrs-gnome
bash install.sh
```

### Pelo zip

Baixe o `gitlab-mrs@matheus.sanches.shell-extension.zip` da página de releases e rode:

```bash
mkdir gitlab-mrs && unzip gitlab-mrs@matheus.sanches.shell-extension.zip -d gitlab-mrs
bash gitlab-mrs/install.sh
```

O `install.sh` copia a extensão para `~/.local/share/gnome-shell/extensions/`, instala as fontes Geist e Geist Mono em `~/.local/share/fonts/Geist/` e ativa a extensão.

Depois:

1. **Wayland** (padrão no Ubuntu): saia da sessão e entre de novo. **X11**: `Alt+F2`, digite `r`, Enter.
2. Clique no ícone de merge request na barra superior → **Configurar** (ou na engrenagem).
3. Informe a URL do GitLab (ex.: `https://gitlab.com`) e o token, e clique em **Salvar**.

## Configuração

Tudo pode ser feito pela tela de configurações. Os dados ficam em `~/.config/gitlab-mrs/`:

| Arquivo | Conteúdo |
|---|---|
| `config.json` | `url`, `token`, `refresh_seconds` (mínimo 30) e `notifications`. Gravado com permissão `600`. |
| `project-order.json` | Ordem dos projetos escolhida arrastando. |

O token só é usado para ler dados da API do GitLab (`read_api`); a extensão não altera nada no GitLab.

## Desinstalação

```bash
bash uninstall.sh
```

Remove a extensão. A configuração e as fontes ficam, e o script mostra onde estão.

## Desenvolvimento

Para testar mudanças sem sair da sessão, abra um GNOME Shell aninhado numa janela:

```bash
bash install.sh   # copia os arquivos para a pasta de extensões
MUTTER_DEBUG_DUMMY_MODE_SPECS=1400x1000 dbus-run-session -- gnome-shell --nested --wayland
```

Erros de JavaScript aparecem no terminal onde o shell aninhado foi aberto.
Para gerar o zip de distribuição (com fontes, scripts e docs): `bash pack.sh` → `dist/`.

Estrutura:

- `extension.js` — indicador da barra, popup, lista, configurações e notificações.
- `api.js` — cliente da API do GitLab (v4) e leitura/gravação da configuração.
- `stylesheet.css` — estilos (St/CSS do GNOME Shell).
- `icons/` — ícone da barra (`merge-symbolic.svg`), ícones da interface (`ui/`) e o degradê do fim da lista.
- `fonts/` — Geist e Geist Mono (pesos 400–700).

## Créditos e licenças

- Código: [MIT](LICENSE).
- Fontes [Geist e Geist Mono](https://github.com/vercel/geist-font) (Vercel): SIL Open Font License 1.1 — [`fonts/OFL.txt`](fonts/OFL.txt).
- Ícones da interface baseados em [Lucide](https://lucide.dev) (ISC), [Remix Icon](https://remixicon.com) (Apache 2.0), [Coolicons](https://github.com/krystonschwarze/coolicons) (CC BY 4.0) e [GitLab Pajamas](https://gitlab.com/gitlab-org/gitlab-svgs) (MIT).
