public class RootCaller {
    public static String go() {
        return AccountService.rootOnlyMethod();
    }

    public static void broken() {
        RootOnlyBroken y = 2;
    }
}
