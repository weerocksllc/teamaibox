<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.pt-BR.md)
<!-- doc-navigation:end -->

# Contribuindo

Obrigado por ajudar a melhorar Team AI Box. Congratulamo-nos com colaboradores iniciantes: relatórios de bugs, traduções, documentação, acessibilidade, integrações de aplicativos e alterações de código específicas, tudo conta. Você não precisa de um DGX Spark para melhorar documentos ou componentes que podem ser verificados de forma independente.

## De uma ideia a uma solicitação pull

1. Pesquise [problemas existentes](https://github.com/weerocksllc/teamaibox/issues). Descreva o problema do usuário, comportamento esperado, comportamento real e versão relevante. Discuta mudanças maiores antes de investir em uma implementação.
2. Bifurque o repositório público e clone seu fork. Crie uma filial focada; não inclua o site de marketing privado, dados de tempo de execução ou modelos baixados.
3. Siga [BUILDING](docs/open-source/BUILDING.pt-BR.md) para compilações de Node, pnpm e componentes locais. O instalador do novo dispositivo tem um fluxo de trabalho diferente: nunca execute-o em uma máquina que contenha dados de negócios apenas para desenvolver a IU.
4. Faça a menor alteração coerente, atualize a documentação afetada e execute as verificações relevantes. Explique quaisquer verificações dependentes de hardware que você não pôde executar.
5. Abra uma solicitação pull descrevendo o problema, solução, impacto de compatibilidade e verificações. Inclua capturas de tela limpas para alterações visíveis. Responder ao feedback da revisão; revisão dos mantenedores antes da fusão.

Um espaço de trabalho OpenSpec local é opcional e não é publicado neste repositório. Os contribuidores públicos podem colocar uma proposta e critérios de aceitação diretamente em uma edição ou PR; nenhuma especificação privada faltante é necessária para participar.

## Traduções e capturas de tela

Todos os 17 idiomas do produto possuem um README. Edite `docs/readme-locales/<locale>.json` e execute `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. Não edite manualmente os READMEs gerados. A lista de localidades vem de `packages/ui-system/src/locale-registry.mjs`. Os guias vinculados de instalação, construção, contribuição, segurança e licenciamento usam os mesmos 17 idiomas. A lista de documentos deles está em `docs/document-locales/manifest.json`. Edite a página do idioma de origem e as traduções de parágrafos em `docs/document-locales/<locale>.json` e execute `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. As chaves de tradução são hashes SHA-256 dos parágrafos originais; uma alteração na origem falha no renderizador até que as traduções correspondentes sejam atualizadas. Exemplos de código são compartilhados literalmente e links de documentos são gerados para o idioma selecionado. Novas traduções são rascunhos assistidos por máquina com código e links protegidos; a revisão linguística e terminológica é bem-vinda. A geração e as verificações são executadas localmente, sem serviço de tradução, chave de API ou acesso a um dispositivo. Consulte [a política de captura de tela](docs/assets/screenshots/README.pt-BR.md) antes de adicionar imagens públicas. As traduções, incluindo a terminologia e o fraseado natural, são contribuições de revisão bem-vindas.

## Regras de contribuição

- As contribuições originais são enviadas sob a licença MIT do repositório. Preserve cabeçalhos de terceiros e indique a fonte/licença do material copiado. Não é necessária nenhuma permissão separada de CLA obrigatória ou de contribuidor pago.
- Use o Nó 24 e a versão pnpm fixada em `package.json`. Os requisitos de Python e Go estão descritos em [CONSTRUÇÃO](docs/open-source/BUILDING.pt-BR.md).
- Execute apenas testes relevantes para sua alteração e relate exatamente o que foi executado. Um acessório local não é uma reivindicação de aceitação real do dispositivo. Não repita ou apague os resultados históricos de aceitação apenas para encerrar uma alteração na documentação.
- Nunca teste a exclusão, reinstalação ou recuperação dos dados de um usuário. Use acessórios sintéticos ou recursos temporários explicitamente designados.
- Sem chaves privadas, tokens, cookies, prompts/arquivos de clientes, imagens de convidados conectados, instantâneos de implantação privados ou capturas de tela pessoais em problemas/PRs. Consulte [SEGURANÇA](SECURITY.pt-BR.md) para relatórios privados.
- Mantenha `private: true` em pacotes de espaço de trabalho. Nunca reescreva o histórico compartilhado do Git, mova tags de entrega ou publique artefatos de construção privados como parte de um PR.

Documente testes, migrações e mudanças de comportamento relevantes em sua contribuição. As verificações dependentes de hardware devem identificar a configuração e os limites reais.
