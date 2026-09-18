import LegalPolicyPage from "../components/LegalPolicyPage";
import termsMarkdown from "../legal-policies/terms.md?raw";
import { withDefaultSocialImage } from "../seo";

export const meta = () =>
  withDefaultSocialImage([
    {
      title: "FB Factory Hosted Services Terms",
    },
    {
      name: "description",
      content:
        "Standalone terms for FB Factory hosted applications, hosted examples, demos, and related services.",
    },
  ]);

export default function TermsPage() {
  return <LegalPolicyPage markdown={termsMarkdown} />;
}
