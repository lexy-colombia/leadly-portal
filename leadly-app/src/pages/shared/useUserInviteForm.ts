import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inviteTenantUser,
  type InviteTenantUserInput,
} from "../../lib/api/users";
import { listTenantRoles } from "../../lib/api/permissions";
import type { Profile, TenantRole } from "../../types/domain";
import {
  isNotBlank,
  isValidE164Phone,
  isValidEmail,
} from "../../lib/validation";
import type { TranslationKey } from "../../i18n/translations";
import { useToast } from "@/contexts/ToastContext";
import { useLanguage } from "@/contexts/LanguageContext";

export const ADMIN_VALUE = "admin";

const schema = z.object({
  fullName: z.string().refine(isNotBlank, {
    message: "auth.errors.nameRequired" satisfies TranslationKey,
  }),
  email: z.string().refine(isValidEmail, {
    message: "auth.errors.invalidEmail" satisfies TranslationKey,
  }),
  phone: z.string().refine((v) => !isNotBlank(v) || isValidE164Phone(v), {
    message: "inbox.newConv.errors.invalidPhone" satisfies TranslationKey,
  }),
  role: z.string().min(1, {
    message:
      "account.invite.errors.tenantRoleRequired" satisfies TranslationKey,
  }),
});

export type UserInviteFormValues = z.infer<typeof schema>;

const EMPTY_VALUES: UserInviteFormValues = {
  fullName: "",
  email: "",
  phone: "",
  role: "",
};

export function useUserInviteForm(tenantId: string, open: boolean) {
  const toast = useToast();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const form = useForm<UserInviteFormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_VALUES,
  });

  const rolesQuery = useQuery<TenantRole[]>({
    queryKey: ["tenantRoles", tenantId],
    queryFn: () => listTenantRoles(tenantId),
    enabled: open,
  });

  const mutation = useMutation<Profile, Error, InviteTenantUserInput>({
    mutationFn: inviteTenantUser,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(EMPTY_VALUES);
    mutation.reset();
  }, [open]);

  useEffect(() => {
    if (!open || !rolesQuery.data) return;
    if (!form.getValues("role")) {
      form.setValue("role", rolesQuery.data[0]?.id || ADMIN_VALUE);
    }
  }, [open, rolesQuery.data]);

  const onSubmit = form.handleSubmit((values) => {
    const isAdmin = values.role === ADMIN_VALUE;
    return mutation
      .mutateAsync({
        email: values.email.trim(),
        full_name: values.fullName.trim(),
        phone: values.phone.trim() || null,
        role: isAdmin ? "tenant_admin" : "tenant_agent",
        tenant_id: tenantId,
        tenant_role_id: isAdmin ? null : values.role,
      })
      .then((profile) => {
        toast.success(`${t("account.invite.sentPrefix")} ${values.email}`, {
          position: "top-right",
        });
        form.reset();
        queryClient.setQueryData<Profile[]>(
          ["tenantUsers", tenantId],
          (prev) => [profile, ...(prev ?? [])],
        );
      })
      .catch(() => {
        toast.error(t("account.invite.errors.failed"), {
          position: "top-right",
        });
      });
  });

  return {
    form,
    roles: rolesQuery.data ?? [],
    mutation,
    ADMIN_VALUE,
    onSubmit,
  };
}
