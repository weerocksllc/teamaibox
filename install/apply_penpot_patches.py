#!/usr/bin/env python3
"""Apply the small version-bound integration overlay to a NEW source tree."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

from offline_common import need


INPUTS = {
    'backend/src/app/rpc.clj': '2856f53b0a1c1e64bc96e35ad6ae02c9603c91bd88fc7a67be0194c7562984fe',
    'backend/src/app/config.clj': '49947f3ffaf9acfc6f7a83078de8772ea29df53d4c84a7d345395ab431448132',
    'backend/src/app/rpc/commands/binfile.clj': '32bb0fc303d2a2bb9ce318eb74d66c8259d91af7828aefe59133010da306cf01',
    'backend/src/app/binfile/common.clj': '0fd84f808841106cf91a6b0fcb246a123e6606622c00467ac917f6212885c06e',
    'backend/src/app/http/websocket.clj': 'd804c7c19bd8e377d38eee36e88f53cc22dbe6d1f01acece98edf5805bdefe06',
    'backend/src/app/migrations.clj': 'd0c7807530a21583764926577832f2e9bcb3782f8636642d90d390f2905b2aba',
    'backend/src/app/util/migrations.clj': 'e68b08911c708d7047990617c31ce73be4fe4c1f75e8b819082bc268891a64e0',
    'backend/src/app/rpc/commands/projects.clj': '7bc5ea75335795b3746b61ca873ed3c4c1fdc01255ab07e4a101aa7adc5fcbe6',
    'backend/src/app/http/assets.clj': 'ca3f1f723c447dcd9fbfb43eed5dc1ea2f394fa86916b56e719d019957ccaeda',
    'exporter/src/app/handlers.cljs': 'aad24253ee23098572f2665cec51cf3b999bc9bc89fccca7bd0f385134fab1c7',
    'exporter/src/app/config.cljs': '9c583418386cf18344eca4cface263443165ea6dd1c178690d3468df2d5391c8',
    'exporter/src/app/handlers/export_shapes.cljs': 'ec35be546209f0d5ebd09c660f11dec255fd0bee692db8979ec8a78e7f129f65',
    'exporter/src/app/handlers/export_frames.cljs': 'bdf20613fa057f35d67955538da38ad976d929d327c1ddf7a6b84ee09ead0a29',
    'exporter/src/app/handlers/resources.cljs': '18fc5a701e654e284bc503e4e7e13618d4d4d54c71292b53ebacde808aa17b51',
    'backend/src/app/rpc/management/exporter.clj': '0b56c92c0ef971d044883fbfe289b212b3bce72d121630c9da5eb36f19f7066c',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def patch_schema_migration_runner(content):
    """Fence database steps before the native runner applies any migration."""
    changes = {
        '[next.jdbc :as jdbc]))': '[next.jdbc :as jdbc]\n   [next.jdbc.result-set :as rs]))',
        '      (run! #(impl-migrate-single conn mname %) steps))))': (
            '      ;; Serialize guarded backend startups for this Penpot database.\n'
            '      (jdbc/execute! conn ["select pg_advisory_xact_lock(1398030672, 1346457168)"])\n'
            '      (let [known (into #{} (map :name) steps)\n'
            '            applied (jdbc/execute! conn ["select step from migrations where module = ?" mname]\n'
            '                                   {:builder-fn rs/as-unqualified-lower-maps})]\n'
            '        (when (some #(not (contains? known (:step %))) applied)\n'
            '          (throw (ex-info "Penpot database has unsupported migrations; use a compatible backend or restore the pre-upgrade copy"\n'
            '                          {:type :penpot-incompatible-schema}))))\n'
            '      (run! #(impl-migrate-single conn mname %) steps))))'),
    }
    for old, new in changes.items():
        need(content.count(old) == 1, 'native migration runner context mismatch')
        content = content.replace(old, new)
    return content


def apply(source, output):
    repository = Path(__file__).resolve().parents[1]
    source, output = Path(source), Path(output)
    need(not output.exists(), 'patch output must be new; existing source is preserved')
    need(not output.resolve().is_relative_to(repository), 'patched upstream source stays outside checkout')
    need(not output.resolve().is_relative_to(source.resolve()), 'patch output cannot be inside source')
    for path in (source, output):
        need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink in patch path')
    lock = json.loads((repository / 'deploy/penpot-source.lock.json').read_text())
    for relative, expected in {**lock['contractFiles'], **INPUTS}.items():
        need(digest(source / relative) == expected, 'patch input mismatch: ' + relative)
    overlay = repository / 'install/penpot-patches/teamaibox_auth.clj'
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='penpot-patch-', dir=output.parent) as stage:
        tree = Path(stage) / 'source'
        shutil.copytree(source, tree, symlinks=True)
        replacements = {
            'backend/src/app/rpc.clj': ("          'app.rpc.commands.auth\n",
                                      "          'app.rpc.commands.auth\n          'app.rpc.commands.teamaibox-auth\n"),
            'backend/src/app/config.clj': ('    [:secret-key {:optional true} :string]\n',
                '    [:secret-key {:optional true} :string]\n'
                '    [:teamaibox-handoff-uri {:optional true} ::sm/uri]\n'
                '    [:teamaibox-handoff-key {:optional true} :string]\n'
                '    [:teamaibox-team-roles-uri {:optional true} ::sm/uri]\n'
                '    [:teamaibox-drive-import-check-uri {:optional true} ::sm/uri]\n'),
            'backend/src/app/migrations.clj': (
                ':fn (mg/resource "app/migrations/sql/0156-reset-pg-storage-defaults.sql")}])',
                ':fn (mg/resource "app/migrations/sql/0156-reset-pg-storage-defaults.sql")}\n\n'
                '   {:name "teamaibox-0001-managed-team"\n'
                '    :fn (mg/resource "app/migrations/sql/teamaibox-0001-managed-team.sql")}\n\n'
                '   {:name "teamaibox-0002-drive-import"\n'
                '    :fn (mg/resource "app/migrations/sql/teamaibox-0002-drive-import.sql")}])'),
            'exporter/src/app/config.cljs': ('   [:secret-key :string]\n',
                '   [:secret-key :string]\n   [:teamaibox-protected-export {:optional true} :string]\n'),
        }
        for relative, (old, new) in replacements.items():
            path = tree / relative
            content = path.read_text()
            need(content.count(old) == 1, 'patch context mismatch: ' + relative)
            path.write_text(content.replace(old, new))
        def replace(relative, old, new):
            path = tree / relative
            content = path.read_text()
            need(content.count(old) == 1, 'native team patch context mismatch: ' + relative)
            path.write_text(content.replace(old, new))
        migration_runner = tree / 'backend/src/app/util/migrations.clj'
        migration_runner.write_text(patch_schema_migration_runner(migration_runner.read_text()))
        def require_team_module(relative):
            replace(relative, '[app.config :as cf]', '[app.config :as cf]\n   [app.teamaibox.teams :as tab-teams]')
        rpc = 'backend/src/app/rpc.clj'
        require_team_module(rpc)
        replace(rpc, '          :else\n          (f cfg params))))))',
            '          :else\n          (do\n'
            '            (when (and (uuid? profile-id) (not= profile-id uuid/zero))\n'
            '              (tab-teams/check-rpc! cfg profile-id (::handler-name params) params))\n'
            '            (f cfg params)))))))')
        migration = tree / 'backend/src/app/migrations/sql/teamaibox-0001-managed-team.sql'
        need(not migration.exists(), 'upstream already defines design team migration')
        migration.write_text('-- Platform-managed flag and immutable native founder. No existing rows changed.\n'
            'ALTER TABLE team ADD COLUMN teamaibox_founder_id uuid;\n'
            'CREATE INDEX teamaibox_managed_team_idx ON team(id) WHERE teamaibox_founder_id IS NOT NULL;\n')
        import_migration = migration.with_name('teamaibox-0002-drive-import.sql')
        need(not import_migration.exists(), 'upstream already defines design import migration')
        import_migration.write_text('CREATE TABLE teamaibox_drive_import (operation_id uuid PRIMARY KEY,'
            ' profile_id uuid NOT NULL, project_id uuid NOT NULL, source_digest text NOT NULL,'
            ' file_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());\n')
        # Direct file/project owner grants remain recorded, but cannot promote
        # a platform viewer or editor beyond the synchronized team ceiling.
        for relative, alias in [('backend/src/app/binfile/common.clj', 'fpr'),
                                ('backend/src/app/binfile/common.clj', 'ppr'),
                                ('backend/src/app/rpc/commands/projects.clj', 'ppr')]:
            old = 'select ' + alias + '.is_owner,\n          ' + alias + '.is_admin,\n          ' + alias + '.can_edit'
            role = '(select tpr.{flag} from team_profile_rel tpr where tpr.team_id=p.team_id and tpr.profile_id=' + alias + '.profile_id)'
            unmanaged = 'not exists (select 1 from team t where t.id=p.team_id and t.teamaibox_founder_id is not null)'
            new = 'select ' + ',\n          '.join(
                f'({alias}.{flag} and ({unmanaged} or {role.format(flag=cap)})) as {flag}'
                for flag, cap in [('is_owner', 'is_admin'), ('is_admin', 'is_admin'), ('can_edit', 'can_edit')])
            replace(relative, old, new)
        export_path = tree / 'backend/src/app/rpc/commands/binfile.clj'
        content = export_path.read_text()
        old_params = '[{:keys [::sto/storage] :as cfg} {:keys [file-id include-libraries embed-assets]}]'
        old_bucket = ':bucket sto/tempfile-bucket})]'
        need(content.count(old_params) == 1 and content.count(old_bucket) == 1,
             'native export owner patch context mismatch')
        content = content.replace(old_params,
            '[{:keys [::sto/storage] :as cfg} {:keys [::rpc/profile-id file-id include-libraries embed-assets]}]')
        content = content.replace(old_bucket, ':bucket sto/tempfile-bucket\n                                     :profile-id profile-id\n'
                                  '                                     :teamaibox-file-id file-id})]')
        export_path.write_text(content)
        binfile = 'backend/src/app/rpc/commands/binfile.clj'
        require_team_module(binfile)
        replace(binfile, '[app.rpc.commands.teams :as teams]', '[app.rpc.commands.teams :as teams]\n'
            '   [app.rpc.helpers :as rph]\n   [yetti.request :as yreq]')
        replace(binfile, '    (try\n      (-> cfg\n          (assoc ::bfc/ids #{file-id})',
            '    (try\n      (when (tab-teams/enabled?)\n'
            '        (tab-teams/synchronize! cfg profile-id)\n'
            '        (files/check-read-permissions! cfg profile-id file-id)\n'
            '        (when (or include-libraries embed-assets)\n'
            '          (doseq [library (bfc/get-libraries cfg #{file-id})]\n'
            '            (files/check-read-permissions! cfg profile-id library))))\n'
            '      (-> cfg\n          (assoc ::bfc/ids #{file-id})')
        import_overlay = overlay.with_name('drive-import.clj')
        export_path.write_text(export_path.read_text() + '\n' + import_overlay.read_text())
        assets = 'backend/src/app/http/assets.clj'
        replace(assets, '[app.storage :as sto]', '[app.storage :as sto]\n   [app.teamaibox.teams :as tab-teams]')
        replace(assets, '      :else\n      (serve-object cfg obj))))',
            '      (and (cf/get :teamaibox-handoff-key)\n'
            '           (or (:teamaibox-file-id (meta obj)) (seq (:teamaibox-source-files (meta obj))))\n'
            '           (let [profile-id (request-profile-id request)\n'
            '                 ids (or (:teamaibox-source-files (meta obj)) [(:teamaibox-file-id (meta obj))])\n'
            '                 pool (::db/pool storage)]\n'
            '             (tab-teams/synchronize! pool profile-id)\n'
            '             (not (every? #(:can-read (perms/get-file-read-permissions pool profile-id %)) ids))))\n'
            '      {::yres/status 404}\n\n      :else\n      (serve-object cfg obj))))')
        replace(assets, '[app.storage :as sto]', '[app.storage :as sto]\n   [app.config :as cf]')
        replace(assets, '            perms      (perms/get-file-read-permissions pool profile-id file-id share-id)]',
            '            _          (when profile-id (tab-teams/synchronize! pool profile-id))\n'
            '            perms      (perms/get-file-read-permissions pool profile-id file-id share-id)]')
        # Protected installations use native membership, never a bearer share
        # link. This covers viewer, page, comment, font and media permission paths.
        common = tree / 'backend/src/app/binfile/common.clj'
        content = common.read_text()
        old = '(some-> (db/get* conn :share-link {:id share-id :file-id file-id})'
        need(content.count(old) == 1, 'native share-link patch context mismatch')
        common.write_text(content.replace(old, '(some-> (when-not (cf/get :teamaibox-handoff-key)\n                           (db/get* conn :share-link {:id share-id :file-id file-id}))'))
        ws = tree / 'backend/src/app/http/websocket.clj'
        content = ws.read_text()
        for old, new in [
            ('[yetti.websocket :as yws]', '[yetti.request :as yreq]\n   [yetti.websocket :as yws]'),
            ('::profile-id profile-id\n                                     ::session-id session-id)',
             '::profile-id profile-id\n                                     ::teamaibox-connection-id (some-> (yreq/get-header request "x-teamaibox-design-connection") uuid/parse*)\n                                     ::session-id session-id)'),
            ('(when (::file-subscription @state)\n    (let [message',
             '(when (and (uuid? file-id) (= file-id (-> @state ::file-subscription :file-id)))\n    (let [message'),
            ('(when (= (:file-id subs) file-id)\n      (mbus/pub!',
             '(when (= (:file-id subs) file-id)\n      (swap! state dissoc ::file-subscription)\n      (mbus/pub!'),
        ]:
            need(content.count(old) == 1, 'native subscription patch context mismatch')
            content = content.replace(old, new)
        ws.write_text(content)
        replace('backend/src/app/http/websocket.clj', '[app.db :as db]', '[app.db :as db]\n   [app.teamaibox.teams :as tab-teams]')
        replace('backend/src/app/http/websocket.clj', '  (teams/check-read-permissions! pool profile-id team-id)',
            '  (tab-teams/synchronize! pool profile-id)\n  (teams/check-read-permissions! pool profile-id team-id)')
        replace('backend/src/app/http/websocket.clj', '  (bfc/check-file-exists pool file-id)',
            '  (tab-teams/synchronize! pool profile-id)\n  (bfc/check-file-exists pool file-id)')
        # Keep the renderer and native token checks. Bind only the private
        # progress recipient; a caller cannot choose somebody else's topic.
        handlers = tree / 'exporter/src/app/handlers.cljs'
        content = handlers.read_text()
        for old, new in [
            ('[app.common.spec :as us]', '[app.common.spec :as us]\n   [app.config :as cf]'),
            ('''  [{:keys [:request/params] :as exchange}]
  (let [{:keys [cmd] :as params} (us/conform ::params params)]
    (l/debug :hint "process-request" :cmd cmd)
    (case cmd
      :export-shapes (export-shapes/handler exchange params)
      :export-frames (export-frames/handler exchange params)
      (ex/raise :type :internal
                :code :method-not-implemented
                :hint (str/istr "method ~{cmd} not implemented")))))''', '''  [{:keys [:request/params :request/headers :request/auth-token] :as exchange}]
  (let [protected? (= "true" (cf/get :teamaibox-protected-export))
        profile    (get headers "x-teamaibox-export-profile")]
    (if (and protected?
             (not (and (string? auth-token) (not (empty? auth-token))
                       (string? profile)
                       (re-matches #"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" profile))))
      (assoc exchange :response/status 403 :response/body "Export access denied")
      (let [params (cond-> params protected? (assoc :profile-id (uuid profile)))
            {:keys [cmd exports] :as params} (us/conform ::params params)
            ids (when protected? (vec (distinct (map :file-id exports))))
            exchange (cond-> exchange protected? (assoc :request/teamaibox-source-files ids))]
        (when (and protected? (not (<= 1 (count ids) 64)))
          (ex/raise :type :validation :code :invalid-export-scope))
        (l/debug :hint "process-request" :cmd cmd)
        (case cmd
          :export-shapes (export-shapes/handler exchange params)
          :export-frames (export-frames/handler exchange params)
          (ex/raise :type :internal
                    :code :method-not-implemented
                    :hint (str/istr "method ~{cmd} not implemented")))))))'''),
        ]:
            need(content.count(old) == 1, 'native exporter boundary patch context mismatch')
            content = content.replace(old, new)
        handlers.write_text(content)
        for name, count in [('export_shapes', 2), ('export_frames', 1)]:
            handler = tree / f'exporter/src/app/handlers/{name}.cljs'
            content = handler.read_text()
            old = '(partial rsc/upload-resource auth-token)'
            need(content.count(old) == count, 'native export resource binding mismatch')
            handler.write_text(content.replace(old, '(partial rsc/upload-resource auth-token (:request/teamaibox-source-files exchange))'))
        resources = 'exporter/src/app/handlers/resources.cljs'
        replace(resources, '[auth-token resource]', '[auth-token source-files resource]')
        replace(resources, '(.append fdata "content" blob (:filename resource))',
            '(.append fdata "content" blob (:filename resource))\n'
            '                   (when (seq source-files)\n'
            '                     (.append fdata "teamaibox-source-files" (str/join "," (map str source-files))))')
        uploader = 'backend/src/app/rpc/management/exporter.clj'
        require_team_module(uploader)
        replace(uploader, '[app.rpc.doc :as doc]', '[app.rpc.doc :as doc]\n'
            '   [app.rpc.permissions :as perms]\n   [app.common.uuid :as uuid]\n   [clojure.string :as str]')
        replace(uploader, '[:content media.v/schema:upload]])',
            '[:content media.v/schema:upload]\n   [:teamaibox-source-files {:optional true} [:string {:max 2368}]]])')
        replace(uploader, '[cfg {:keys [::rpc/profile-id content]}]', '[cfg {:keys [::rpc/profile-id content teamaibox-source-files]}]')
        replace(uploader, '  (let [storage (sto/resolve cfg)',
            '  (let [ids (when (cf/get :teamaibox-handoff-key)\n'
            '              (let [values (when (string? teamaibox-source-files) (mapv uuid/parse* (str/split teamaibox-source-files #"," -1)))]\n'
            '                (when-not (and (uuid? profile-id) (<= 1 (count values) 64) (every? some? values)) (tab-teams/deny!))\n'
            '                (tab-teams/synchronize! cfg profile-id)\n'
            '                (when-not (every? #(:can-read (perms/get-file-read-permissions cfg profile-id %)) values) (tab-teams/deny!))\n'
            '                values))\n        storage (sto/resolve cfg)')
        replace(uploader, ':bucket sto/tempfile-bucket}', ':bucket sto/tempfile-bucket\n                 :teamaibox-source-files ids}')
        target = tree / 'backend/src/app/rpc/commands/teamaibox_auth.clj'
        need(not target.exists(), 'upstream already defines integration namespace')
        shutil.copyfile(overlay, target)
        teams_overlay = overlay.with_name('teamaibox_teams.clj')
        teams_target = tree / 'backend/src/app/teamaibox/teams.clj'
        need(not teams_target.exists(), 'upstream already defines team integration namespace')
        teams_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(teams_overlay, teams_target)
        (tree / 'teamaibox-patches.json').write_text(json.dumps({
            'upstreamCommit': lock['commit'],
            'patcherSha256': digest(Path(__file__).resolve()),
            'overlaySha256': digest(overlay),
            'teamsOverlaySha256': digest(teams_overlay),
            'driveImportOverlaySha256': digest(import_overlay),
            'modified': {path: digest(tree / path) for path in INPUTS},
        }, indent=2) + '\n')
        need(not output.exists(), 'patch output appeared during preparation')
        tree.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(apply(args.source, args.output))
