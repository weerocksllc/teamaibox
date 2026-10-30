<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.pt-BR.md)
<!-- doc-navigation:end -->

# Liberar limites

## Artefatos separados

1. **MIT candidato de origem**: código original, especificações atuais, ferramentas de construção/teste revisadas e avisos; nenhum histórico do Git ou evidência de laboratório privado.
2. **Material de terceiros**: fonte/binários/modelos upstream exatos com licença e atribuição próprias. As obrigações de origem copyleft viajam com binários.
3. **Pacote completo de dispositivos off-line**: desenvolvido por `install/`; não licenciado automaticamente para redistribuição pública. Os componentes GMS, HunyuanOCR, NVIDIA e licenças de convidado/firmware exigem revisão específica do artefato. Não publique o pacote privado, pacotes de modelo ou imagens conectadas sob o rótulo MIT.
4. **Site de marketing**: `website/`, incluindo seus modelos de artigo, conteúdo, ativos de design, análises e configuração de implantação, permanece no repositório privado `weerocksllc/teamaibox.com` do GitHub. GitLab é um arquivo histórico, não um repositório de desenvolvimento de sites. O site não faz parte da distribuição pública de fontes de produtos. A IU do navegador do dispositivo em `apps/` continua fazendo parte do produto de código aberto.

Scripts históricos de implantação, recuperação e registro de evidências em um dispositivo não são ferramentas de produto reutilizáveis. A política de lançamento exclui scripts e snapshots retirados; não os restaure do arquivo privado. As ferramentas retidas exigem alvos explícitos fornecidos pelo operador, em vez de hosts, contas, contêineres ou arquivos de evidências do desenvolvedor. Execute a verificação confidencial complementar, bem como Gileaks: IDs de dispositivos, IDs de contêineres, hashes GSF e nomes de contas pessoais estão testando metadados mesmo quando não são credenciais de login utilizáveis. A limpeza do histórico público requer autorização explícita do proprietário e nunca deve reescrever o arquivo privado ou suas tags de entrega. Após uma reescrita autorizada, use um novo clone público em vez de mesclar o histórico retirado de volta ao repositório mantido.

O repositório de desenvolvimento interno e suas tags permanecem intactos. Seu histórico acessível contém registros de implantação antigos e ativos SDK proprietários retirados; não deve ser tornado público inalterado. Uma nova árvore exportada fornece o ponto de partida público sem reescrever silenciosamente o histórico de entrega original.

## Preparação local

Use o **Gitleaks 8.30.1**, baixado de sua versão oficial do GitHub e verifique sua soma de verificação. A ferramenta de auditoria nunca instala pacotes do sistema nem carrega dados. A saída privada é ignorada `.runtime/open-source-audit/`, não um PR público.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Os resultados devem ser novos caminhos; as ferramentas nunca substituem os candidatos anteriores. Revise os locais editados, não apenas as contagens. Documente acessórios sintéticos, credenciais de bootstrap públicas, falsos positivos de identificador e credenciais privadas reais/possíveis separadamente. As varreduras de padrão não podem validar credenciais ou capturas de tela de OCR. Os artefatos binários são excluídos e não são declarados limpos como digitalizados. O exportador de origem admite apenas arquivos conhecidos do Git e entradas explícitas não rastreadas em [release-policy.json](release-policy.json). Novos insumos não rastreados precisam ser revisados. Ele rejeita links simbólicos e travessia de caminho e emite SHA-256 por arquivo mais exclusões. `website/` é sempre excluído, mesmo se for rastreado ou listado como uma entrada não rastreada. Nunca copie o diretório `.git` do repositório privado em um checkout público. Antes de publicar, verifique se a árvore e todos os commits públicos acessíveis não contêm arquivos de site; excluir arquivos em um commit posterior não remove o histórico antigo.

A verificação suplementar inclui mensagens de commit/tag acessíveis, credenciais de baixa entropia e literais de login, identidades de dispositivos e endereços de desenvolvimento. Os testes não são automaticamente isentos: explique por que cada acessório retido é sintético. Valores privados conhecidos podem ser fornecidos com `--denylist` como uma matriz JSON externa de registros `{id, value, word?}`. Use IDs opacos e não confidenciais; mantenha este arquivo fora da verificação de origem. Os relatórios mostram locais e hashes, nunca os valores. Uma correspondência de marcador conhecido faz com que a verificação falhe. Use `--scope worktree` durante a limpeza; inspecione `--scope all` no novo repositório de lançamento sem pai antes de publicar. Não publique o histórico antigo ou relatórios de revisão privados.

O único padrão intencional do administrador de fábrica é `admin / admin`; altere-o durante a implantação. As ferramentas de implantação/teste do navegador devem receber credenciais de conta existentes por meio de entrada local protegida. As contas de teste de fumaça recém-criadas usam credenciais aleatórias e são desativadas durante a limpeza. Uma limpeza com falha é uma falha no teste, e não uma execução bem-sucedida. O encerramento abrupto do processo pode impedir a limpeza; os operadores devem reconciliar as suas contas temporárias após tal interrupção. Nenhum documento público afirma que uma credencial de teste é válida atualmente.

Somente o ponto de entrada `install/` mantido é um caminho de instalação de dispositivo limpo. A avaliação de propriedade do componente está em [OWNERSHIP.md](OWNERSHIP.pt-BR.md).

Nenhum comando aqui empurra o Git, altera a visibilidade, reescreve o histórico, alterna credenciais ativas, altera um dispositivo ou concede direitos de redistribuição a terceiros. A liberação pública requer um destino público explicitamente escolhido e uma revisão final do artefato. Preservar `delivery-2026-10-22` no repositório privado.
