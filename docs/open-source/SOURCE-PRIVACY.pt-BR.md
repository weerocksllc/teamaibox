<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.pt-BR.md)
<!-- doc-navigation:end -->

# Limite de privacidade de fonte pública

O repositório público de produtos é um novo instantâneo de origem, não um espelho do histórico de desenvolvimento privado. O site de marketing possui seu próprio repositório privado e não está incluído aqui.

## Material removido

- Nomes e senhas de contas de teste de implantação corrigidos e listas de contas pessoais.
- Wrappers e scripts de implantação/recuperação de um dispositivo que registravam identidades históricas de dispositivos ou afirmavam resultados de evidências privadas.
- Endereços de host reais, diretórios iniciais, identidades de contêineres/dispositivos e instantâneos históricos de manutenção. Os testes retidos usam acessórios explicitamente sintéticos; ferramentas operacionais mantidas requerem entradas de alvo explícitas.
- Discos convidados, estado de login do Android, sessões do navegador, pacotes de instalação, pesos de modelo e evidências privadas estão fora da distribuição de fonte pública.

O arquivo privado e as etiquetas de entrega originais permanecem intactos. Nada nesta limpeza de origem altera contas de dispositivos, dados de convidados, serviços em execução ou implantação de sites. O padrão de fábrica `admin / admin` é mantido deliberadamente; não é uma credencial privada. Os administradores devem alterá-lo antes da exposição.

## Revisão e verificação

Revise a árvore de trabalho e todos os commits/tags acessíveis no repositório que está sendo publicado. Use Gileaks mais `tools/open_source_sensitive.py`; nenhum deles é prova de que senhas de baixa entropia ou metadados pessoais estejam ausentes. Compare valores privados antigos confirmados usando uma lista de bloqueios externa privada, nunca um dispositivo de teste confirmado. Revise as descobertas restantes individualmente, incluindo arquivos de teste.

As verificações de limpeza são verificação de política de origem, regressão sintética, configuração e sintaxe. Eles não fazem login usando credenciais descobertas, não reinstalam uma caixa ou repetem a aceitação do produto. A correção anterior do empacotamento da API (incluindo a fonte da UI compartilhada e a verificação do ponto de entrada somente de importação) permanece na origem.

Novos clones não devem importar commits, refs ou tags retirados. A exclusão de um repositório não recupera cópias já baixadas por outros. Nenhuma varredura pode estabelecer que uma credencial desconhecida nunca foi copiada; uma credencial que foi realmente usada deve ser rotacionada por seu operador. Esta limpeza não afirma ter girado.

Consulte [RELEASING.md](RELEASING.pt-BR.md) para obter instruções de exportação e revisão de origem e [BUILDING.md](BUILDING.pt-BR.md) para pré-requisitos de compilação e ativos obtidos separadamente.
