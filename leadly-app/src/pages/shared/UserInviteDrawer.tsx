import { Controller } from "react-hook-form";
import { useLanguage } from "../../contexts/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { Drawer } from "@/components/organisms";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldInput,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUserInviteForm } from "./useUserInviteForm";

export function UserInviteDrawer({
  open,
  onClose,
  tenantId,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
}) {
  const { t } = useLanguage();
  const { form, roles, mutation, ADMIN_VALUE, onSubmit } = useUserInviteForm(
    tenantId,
    open,
  );
  const { control } = form;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("account.invite.title")}
      description={t("account.invite.description")}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Controller
          name="fullName"
          control={control}
          render={({ field, fieldState }) => {
            const error = fieldState.error;

            return (
              <FieldInput
                id="invite-full-name"
                label={t("auth.signup.yourName")}
                placeholder={t("auth.namePlaceholder")}
                error={error?.message && t(error.message as TranslationKey)}
                aria-invalid={!!error?.message}
                aria-describedby={
                  error?.message ? "full-name-at-error" : undefined
                }
                {...field}
              />
            );
          }}
        />

        <Controller
          name="email"
          control={control}
          render={({ field, fieldState }) => {
            const error = fieldState.error;

            return (
              <FieldInput
                id="invite-email"
                type="email"
                label={t("account.field.email")}
                placeholder="persona@empresa.com"
                error={error?.message && t(error.message as TranslationKey)}
                aria-invalid={!!error?.message}
                aria-describedby={error?.message ? "email-at-error" : undefined}
                {...field}
              />
            );
          }}
        />

        <Controller
          name="phone"
          control={control}
          render={({ field, fieldState }) => {
            const error = fieldState.error;

            return (
              <FieldInput
                id="invite-phone"
                type="email"
                label={t("account.invite.phoneOptional")}
                placeholder="+573001234567"
                error={error?.message && t(error.message as TranslationKey)}
                aria-invalid={!!error?.message}
                aria-describedby={error?.message ? "email-at-error" : undefined}
                {...field}
              />
            );
          }}
        />

        <Controller
          control={control}
          name="role"
          render={({ field, fieldState }) => {
            const error = fieldState.error;
            return (
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor="invite-role">
                  {t("account.invite.role")}
                </FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="invite-role"
                    aria-invalid={!!error}
                    className="w-full"
                  >
                    <SelectValue
                      placeholder={t("account.invite.tenantRolePlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ADMIN_VALUE}>
                      {t("account.role.tenantAdmin")}
                    </SelectItem>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError>
                  {error?.message && t(error.message as TranslationKey)}
                </FieldError>
              </Field>
            );
          }}
        />

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button
            type="submit"
            variant="secondary"
            disabled={mutation.isPending}
          >
            {mutation.isPending
              ? t("account.invite.submitting")
              : t("account.invite.submit")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.actions.cancel")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
