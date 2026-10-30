import "./company-footer.css";

export function CompanyFooter({ placement }: { placement: "login" | "sidebar" }) {
  return (
    <footer className={`company-footer company-footer--${placement}`}>
      <span dir="ltr">© {new Date().getFullYear()} Weerocks LLC</span>
      <a href="mailto:teamaibox@weerocks.llc" dir="ltr">teamaibox@weerocks.llc</a>
    </footer>
  );
}
