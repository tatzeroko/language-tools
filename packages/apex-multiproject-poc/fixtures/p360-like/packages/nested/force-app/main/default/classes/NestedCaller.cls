public class NestedCaller {
    public static Integer go() {
        return AccountService.nestedOnlyMethod();
    }

    public static void broken() {
        NestedOnlyBroken x = 1;
    }
}
