import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { FileArchive, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { PaymentEvidenceSubmitPage } from './components/evidence/PaymentEvidenceSubmitPage';
import { PaymentEvidenceVaultPage } from './components/evidence/PaymentEvidenceVaultPage';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { useAuth } from './data/auth-store';

function LoadingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        인증 상태 확인 중
      </div>
    </main>
  );
}

function LoginPage() {
  const { authError, isFirebaseAuthEnabled, loginWithGoogle } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground">
      <Card className="w-full max-w-md border-border/60 bg-white shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] text-muted-foreground" style={{ fontWeight: 700 }}>submitMYSC</p>
              <h1 className="mt-1 text-[22px]" style={{ fontWeight: 900, letterSpacing: 0 }}>
                관리자 로그인
              </h1>
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                비용지급 증빙 케이스, 제출 링크, Google Drive 정본 업로드를 관리합니다.
              </p>
            </div>
          </div>

          <Button
            type="button"
            className="mt-6 h-10 w-full gap-2"
            onClick={() => void loginWithGoogle()}
            disabled={!isFirebaseAuthEnabled}
          >
            <LogIn className="h-4 w-4" />
            Google 계정으로 계속
          </Button>

          {!isFirebaseAuthEnabled && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
              Firebase Auth가 비활성화되어 있습니다. 프로덕션에서는 VITE_FIREBASE_AUTH_ENABLED=true가 필요합니다.
            </p>
          )}
          {authError && (
            <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-800">
              {authError}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function AdminShell() {
  const { user, logout } = useAuth();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
              <FileArchive className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] text-muted-foreground" style={{ fontWeight: 800 }}>submitMYSC</p>
              <h1 className="truncate text-[18px]" style={{ fontWeight: 900, letterSpacing: 0 }}>
                비용지급 증빙 제출 관리
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {user && (
              <span className="hidden rounded-md border border-border/70 bg-white px-2 py-1 text-[11px] text-muted-foreground sm:inline-flex">
                {user.email}
              </span>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
              로그아웃
            </Button>
          </div>
        </header>
        <PaymentEvidenceVaultPage />
      </div>
    </main>
  );
}

function ProtectedAdminPage() {
  const auth = useAuth();
  if (auth.isLoading) return <LoadingPage />;
  if (!auth.isAuthenticated) return <LoginPage />;
  if (!auth.isAdmin()) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-rose-200 bg-white shadow-sm">
          <CardContent className="p-6">
            <p className="text-[15px]" style={{ fontWeight: 900 }}>접근 권한이 없습니다.</p>
            <p className="mt-2 text-[12px] text-muted-foreground">
              submitMYSC 관리자 allowlist에 포함된 계정만 사용할 수 있습니다.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }
  return <AdminShell />;
}

function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border/60 bg-white shadow-sm">
        <CardContent className="p-6">
          <p className="text-[15px]" style={{ fontWeight: 900 }}>페이지를 찾을 수 없습니다.</p>
          <p className="mt-2 text-[12px] text-muted-foreground">
            제출 링크는 /submit/:token 형식입니다.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/admin" replace /> },
  { path: '/admin', element: <ProtectedAdminPage /> },
  { path: '/submit/:token', element: <PaymentEvidenceSubmitPage /> },
  { path: '/payment-evidence/submit/:token', element: <PaymentEvidenceSubmitPage /> },
  { path: '*', element: <NotFoundPage /> },
]);
